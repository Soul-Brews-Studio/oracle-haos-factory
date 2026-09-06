# discord_pb

Self-contained local HAOS add-on: PocketBase 0.29.3, private archive collection,
and a fresh Discord REST backfill. Configure `bot_token` only through Supervisor
options and `channels` as comma-separated IDs. Neither value is baked into the
image or logged. A unique `message_id` index makes repeated walks idempotent.

`auto_login` defaults off because its token endpoint gives any caller able to
reach port 8110 full PocketBase superuser access. The HA ingress panel is admin
only, but the mapped TCP port is a separate trust boundary.

Local parity check:

```sh
CHANNELS=123,456 PB_URL=http://127.0.0.1:8110 ./verify.sh
```
