'use strict';

/**
 * nodebb-plugin-bridge-upload
 *
 * Exposes ONE authenticated upload endpoint so an external bridge (the Discord
 * relay) can attach images, video and audio to forum posts.
 *
 * WHY THIS EXISTS
 * ---------------
 * NodeBB's Write API (v3) has NO upload endpoint at all:
 *   - `src/api/files.js` only implements `delete` and `createFolder`;
 *   - the `PUT /api/v3/files` route is commented out in
 *     `src/routes/write/files.js`.
 *
 * The only upload route that exists is `POST /api/post/upload` in
 * `src/routes/api.js`, and it is deliberately built for the browser session:
 *
 *     const postMiddlewares = [
 *         middleware.maintenanceMode,
 *         upload.array('files[]', 20),
 *         middleware.applyCSRF,
 *         middleware.validateFiles,
 *         middleware.uploads.ratelimit,
 *     ];
 *     router.post('/post/upload', postMiddlewares, ...);
 *
 * Note what is MISSING: `middleware.authenticateRequest`. Without it `req.uid`
 * stays 0, so `privileges.global.can('upload:post:image', req.uid)` fails and the
 * request is rejected with a bare `Forbidden` - for an admin uid too, because
 * the uid is never read in the first place. Verified: `_uid=12` and `_uid=2` both
 * answer `403 Forbidden`.
 *
 * Logging in over the web API is not an option either: `spam-be-gone` has
 * `loginTurnstileEnabled = on`, so `POST /api/v3/utilities/login` answers
 * `403 "Captcha not verified, are you a robot?"`.
 *
 * So the upload capability is provided as a PLUGIN route instead. It uses
 * `routeHelpers.setupApiRoute`, which prepends the full standard stack:
 *
 *     middleware.autoLocale, middleware.applyBlacklist,
 *     middleware.authenticateRequest,      <-- req.uid is set here
 *     middleware.maintenanceMode, middleware.registrationComplete,
 *     middleware.pluginHooks, middleware.logApiUsage,
 *     upload.any()                        <-- multipart parsing for post/put/patch
 *
 * That means a normal API token (or a master token with `_uid`) authenticates
 * exactly as it does for every other v3 call, and no captcha or CSRF dance is
 * needed. It is not a privilege bypass: `uploadsController.uploadPost` still
 * checks `upload:post:image` / `upload:post:file` for the authenticated uid, and
 * every upload still goes through `image.isFileTypeAllowed`, EXIF stripping,
 * resizing and the upload rate limiter.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const pluginData = require('./plugin.json');

// Resolve NodeBB core modules from the APP ROOT, not from this plugin's own
// directory. This plugin is installed as a symlink into /opt/nodebb/plugins, so
// the usual `../../src/routes/helpers` relative require walks out of the app and
// throws "Cannot find module". `module.parent` is NOT a safe anchor either: when
// the plugin is required directly (tests, probes) it is undefined, and the
// resulting TypeError makes NodeBB skip the plugin with no useful message.
//
// The lookup lives in ./app-root.js rather than here so it can be tested.
// Requiring this file pulls in src/routes/helpers, and NodeBB core calls
// process.exit(0) when those modules are loaded outside a booted app — so
// `require('./library')` cannot be used as a test subject at all.
const { resolveAppRoot } = require('./app-root');

const APP_ROOT = resolveAppRoot();
const coreRequire = require('module').createRequire(path.join(APP_ROOT, 'package.json'));

const routeHelpers = coreRequire(path.join(APP_ROOT, 'src/routes/helpers'));
const uploadsController = coreRequire(path.join(APP_ROOT, 'src/controllers/uploads'));
const middleware = coreRequire(path.join(APP_ROOT, 'src/middleware'));

// Hard ceiling per request, matching NodeBB's own composer limit. The bridge
// splits larger sets into several requests rather than one giant upload.
const MAX_FILES_PER_REQUEST = 20;

// Guard so a re-fire of static:app.load cannot register the route twice.
let mounted = false;

// Where multer stages incoming parts before NodeBB moves them into place.
//
// NodeBB 4.16 ships `src/middleware/multer.js` as `multer.diskStorage({})` with
// NO destination. In multer 2.x that is broken: `storage/disk.js` line 56 falls
// back to its internal `getDestination`, which never calls the callback, so
// `destination` stays undefined and every file lands with `path: undefined`.
// `uploadsController.uploadPost` then dies with
// `The "path" argument must be of type string. Received undefined`.
//
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'nodebb-bridge-upload');

/**
 * Give multer a destination it can actually use.
 *
 * NodeBB 4.16's `src/middleware/multer.js` does, at MODULE scope:
 *
 *     const storage = multer.diskStorage({});        // no destination
 *
 * and in multer 2.x that is broken. `multer/storage/disk.js` line 56 only uses
 * `opts.destination` when it is a string or a function:
 *
 *     if (typeof opts.destination === 'string') { ... }
 *     this.getDestination = (opts.destination || getDestination)
 *
 * The fallback `getDestination` never invokes its callback, so `destination`
 * stays undefined, every file gets `path: undefined`, and
 * `uploadsController.uploadPost` dies with
 * `The "path" argument must be of type string. Received undefined`.
 *
 * Re-parsing the multipart body ourselves is NOT an option: `setupApiRoute`
 * injects its own `upload.any()` BEFORE any middleware we pass, so by the time
 * ours runs the body is already consumed ("Unexpected end of form").
 *
 * The workable hook is `multer.diskStorage` itself. NodeBB builds `storage`
 * once at module scope, and `multerUpload()` is only invoked per request, so
 * patching `diskStorage` before NodeBB requires `middleware/multer` rewrites
 * that single storage object. Idempotent, and it also repairs the composer /
 * `/api/post/upload` route, which has the same defect.
 *
 * @returns {boolean} true when the patch was installed by this call
 */
function ensureMulterDestination() {
	const multer = coreRequire('multer');
	const multerMiddlewarePath = path.join(APP_ROOT, 'src/middleware/multer.js');
	const nodebbUpload = require.cache[multerMiddlewarePath] &&
		require.cache[multerMiddlewarePath].exports;
	if (!nodebbUpload || nodebbUpload.__bridgeUploadPatched) {
		return false;
	}

	// NodeBB builds `storage` at module scope in `src/middleware/multer.js`
	// (`multer.diskStorage({})` - no destination), and `routes/api.js` requires
	// that module while `routes/index.js` is still evaluating, i.e. BEFORE any
	// plugin loads. That object is module-private, so `multer.diskStorage` cannot
	// be patched in time to help it.
	//
	// In multer 2.x the missing destination is fatal: `multer/storage/disk.js`
	// line 56 falls back to an internal `getDestination` that never calls its
	// callback, so every file lands with `path: undefined` and
	// `uploadsController.uploadPost` throws
	// `The "path" argument must be of type string. Received undefined`.
	//
	// `module.exports.any()` is a plain arrow property that calls the private
	// `multerUpload()` per request, so replacing it on the cached exports object
	// reaches every caller - including `setupApiRoute`, which does
	// `require('../middleware/multer')` and gets the very same object - without
	// needing the private `storage` itself.
	const meta = coreRequire(path.join(APP_ROOT, 'src/meta'));
	const fixedStorage = multer.diskStorage({ destination: TEMP_UPLOAD_DIR });

	nodebbUpload.any = () => (req, res, next) => {
		fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
		multer({
			storage: fixedStorage,
			// UTF-8 file names are mis-decoded by multer/busboy; NodeBB's own
			// fileFilter fixes this and we must keep it.
			fileFilter: (rq, file, cb) => {
				file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf-8');
				cb(null, true);
			},
			limits: {
				fields: 20,
				files: MAX_FILES_PER_REQUEST,
				parts: 40,
				fileSize: meta.config.maximumFileSize * 1024,
				fieldNestingDepth: 3,
			},
		}).any()(req, res, next);
	};

	// Patch the factory too, so any storage built later is safe.
	const originalDiskStorage = multer.diskStorage.bind(multer);
	multer.diskStorage = function diskStorage(opts = {}) {
		if (!opts.destination) {
			fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
			return originalDiskStorage({ ...opts, destination: TEMP_UPLOAD_DIR });
		}
		return originalDiskStorage(opts);
	};
	multer.__bridgeUploadPatched = true;
	nodebbUpload.__bridgeUploadPatched = true;
	return true;
}

/**
 * Mount POST /api/v3/bridge-upload.
 *
 * The router arrives as an ARGUMENT on `static:app.load`, not as
 * `Plugin.router`. `src/routes/index.js` calls
 * `plugins.reloadRoutes({ router })`, which fires:
 *
 *   await Plugins.hooks.fire('static:app.load', {
 *       app, router: params.router, middleware, controllers,
 *   });
 *
 * so the hook method receives that object as its single parameter.
 * Reading `Plugin.router` yields undefined and the route is never mounted -
 * which shows up as `404 Invalid API call` even though the plugin loaded.
 *
 * Multipart, one or more files under `files[]`. Responds in the same shape as
 * the composer upload so the bridge can reuse NodeBB's own parsing:
 *
 *   { status: {...}, response: { images: [{ url, name }, ...] } }
 *
 * `images` is used for both images and non-image files, because that is what
 * `uploadsController.upload` returns.
 *
 * @param {object} data  { router, middleware, controllers, app }
 */
function load(data) {
	const router = data && data.router;
	if (!router) {
		// eslint-disable-next-line no-console
		console.warn('[bridge-upload] static:app.load fired without a router; route not mounted');
		return;
	}
	if (mounted) {
		return;
	}
	mounted = true;

	// Harmless hardening, NOT the fix for the 500. Keep it: it guarantees a real
	// destination regardless of multer's internal fallback, and also repairs
	// core's `/api/post/upload`, which has the same destination-less storage.
	if (ensureMulterDestination()) {
		// eslint-disable-next-line no-console
		console.log(`[${pluginData.id}] patched multer.diskStorage destination -> ${TEMP_UPLOAD_DIR}`);
	}

	routeHelpers.setupApiRoute(
		// The FULL path is required, not a relative one. `plugins.reloadRoutes`
		// hands us the top-level app router BEFORE `writeRoutes.reload` mounts the
		// `/api/v3` sub-router, so a relative '/bridge-upload' would be registered
		// at the site root and every call would 404 with "Invalid API call". Core
		// does the same thing: `setupApiRoute(router, 'get', '/api/v3/ping', ...)`.
		router, 'post', '/api/v3/bridge-upload',
		[
			// THE missing piece. `uploadsController.upload` reads
			// `path.extname(uploadedFile.name)` and `uploadedFile.type`, but multer
			// only ever sets `originalname` / `mimetype`. Core converts between the
			// two in `middleware.validateFiles` (src/middleware/index.js:104-115:
			// "multer uses originalname and mimetype, but we use name and type"),
			// which it wires into its own upload routes (src/routes/api.js:28-32)
			// - but NOT into `setupApiRoute`, which only injects `upload.any()`.
			// Without this, `name` is undefined and `path.extname(undefined)`
			// throws "The "path" argument must be of type string. Received
			// undefined" out of uploads.js:215. Also normalises multer's
			// `req.files` object into the array the controller requires.
			middleware.validateFiles,
			// setupApiRoute already applied upload.any(); NodeBB's own route also
			// caps the count and ratelimits, so reuse both.
			(req, res, next) => {
				if (Array.isArray(req.files) && req.files.length > MAX_FILES_PER_REQUEST) {
					return res.status(400).json({
						status: {
							code: 'bad-request',
							message: `too many files (max ${MAX_FILES_PER_REQUEST} per request)`,
						},
						response: {},
					});
				}
				return next();
			},
			middleware.uploads.ratelimit,
		],
		(req, res) => uploadsController.uploadPost(req, res)
	);

	// eslint-disable-next-line no-console
	console.log(`[${pluginData.id}] mounted POST /api/v3/bridge-upload`);
}

/**
 * `load` MUST be a property of module.exports at require time.
 *
 * `src/plugins/hooks.js` resolves the hook target eagerly, while the plugin is
 * being registered:
 *
 *     const method = data.method.split('.').reduce((memo, prop) => { ... },
 *                                             plugins.libraries[data.id]);
 *
 * `plugins.libraries[id]` is `require(libraryPath)`, so with the usual
 * `module.exports = function (Plugin) { Plugin.load = ... }` shape the `load`
 * property does not exist yet at that moment: the factory has not been called.
 * `memo['load']` becomes null, the hook is registered with a null method, and
 * `static:app.load` silently never calls it - the plugin loads cleanly, logs
 * nothing, and the route simply does not exist (404 "Invalid API call").
 *
 * Exporting `load` directly on module.exports makes it resolvable immediately.
 */
module.exports = { load, MAX_FILES_PER_REQUEST, APP_ROOT };

// Exposed so tests can invoke the same controller NodeBB would.
module.exports.uploadPost = uploadsController.uploadPost;

/**
 * Legacy entry point. Some loaders call the module export as a factory with the
 * plugin object; keeping a callable `init` costs nothing and preserves that path
 * without re-introducing the late `Plugin.load` assignment above.
 */
module.exports.init = function (Plugin) {
	if (Plugin && Plugin.log && typeof Plugin.log.info === 'function') {
		Plugin.log.info(`[${pluginData.id}] loaded`);
	}
};