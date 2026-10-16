#!/usr/bin/env bash
# Enable the media the Discord bridge needs to mirror, on the live NodeBB forum.
#
# TWO independent blockers were found empirically (not guessed):
#
#  1. ALLOWED TYPES. NodeBB's `image.isFileTypeAllowed` checks the extension
#     against `config.allowedFileExtensions`, which was:
#         png,jpg,bmp,txt,webp,webm,mp4,gif
#     so audio failed with a literal:
#         "Invalid file type .mp3. Allowed types are: .png, .jpg, ... .mp4, .gif"
#
#  2. A PRIVILEGE, not a type. mp4 PASSED the type check and then failed with
#     403 "You do not have enough privileges for this action." Reason:
#     `upload:post:file` is granted to
#         Global Moderators, verified-users
#     while `upload:post:image` is granted to those PLUS `registered-users`.
#     The bridge account is only in registered-users, so every NON-image
#     upload was rejected. That is why asUid=1 and asUid=2 both uploaded the
#     same mp4 fine while asUid=12 got 403.
#
# FIX: give registered-users the file privilege (matching the existing row shape
# exactly - membership is stored by group NAME in legacy_zset.value), and extend
# the extension list with audio types. BACKUP FIRST; both statements are
# reversible (see the archive note in the commit).
set -euo pipefail

BACKUP=/root/.hermes/archive/nodebb-media-2026-10-17
mkdir -p "$BACKUP"
[ -f "$BACKUP/nodebb-keys.sql" ] || su postgres -c \
  "pg_dump -t legacy_hash -t legacy_zset -t legacy_object -d nodebb" > "$BACKUP/nodebb-keys.sql"
[ -f "$BACKUP/config.json.bak" ] || cp /opt/nodebb/app/config.json "$BACKUP/config.json.bak"

echo "════ 1. grant upload:post:file to registered-users ════"
su postgres -c "psql -d nodebb -At -c \"
  INSERT INTO legacy_zset (_key, value, score, type)
  VALUES ('group:cid:0:privileges:groups:upload:post:file:members',
          'registered-users', (extract(epoch from clock_timestamp())*1000)::bigint, 'zset')
  ON CONFLICT DO NOTHING;\"" | sed 's/^/  /'

echo "════ 2. extend allowedFileExtensions with audio ════"
# Build the merged list in node rather than SQL: postgres refuses
# `string_agg(DISTINCT x ORDER BY array_position(...))` because the ORDER BY
# expression is not in the argument list. The canonical order is the one below;
# any extension already on the forum but not listed is kept, appended.
CANON='png,jpg,jpeg,bmp,txt,webp,webm,mp4,gif,mp3,ogg,oga,opus,wav,m4a,flac,aac'
CUR=$(su postgres -c "psql -d nodebb -At -c \"select data::jsonb->>'allowedFileExtensions' from legacy_hash where _key='config'\"")

MERGED=$(CANON="$CANON" CUR="$CUR" node -e '
const canon = process.env.CANON.split(",").map((s) => s.trim()).filter(Boolean);
const cur = new Set((process.env.CUR || "").split(",").map((s) => s.trim()).filter(Boolean));
const merged = [...canon];
for (const e of cur) { if (!merged.includes(e)) merged.push(e); }
process.stdout.write(merged.join(","));
')

su postgres -c "psql -d nodebb -At -c \
  \"UPDATE legacy_hash SET data = jsonb_set(data::jsonb,'{allowedFileExtensions}',to_jsonb('$MERGED'::text),true) WHERE _key='config'\"" | sed 's/^/  /'

echo "════ verify ════"
su postgres -c "psql -d nodebb -At -c \
  \"select '  allowedFileExtensions = '||(data::jsonb->>'allowedFileExtensions') from legacy_hash where _key='config'\"" | sed 's/^/  /'
su postgres -c "psql -d nodebb -F', ' -At -c \
  \"select '  upload:post:file  holders = '||string_agg(value,', ') from legacy_zset where _key='group:cid:0:privileges:groups:upload:post:file:members'\"" | sed 's/^/  /'
