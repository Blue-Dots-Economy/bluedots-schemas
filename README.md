# bluedots-schemas

Shared schema definitions and per-network `network.json` configuration for the Blue Dots services.

## Notification-service catalogues

Each network and brand directory holds an `ns-catalogue.json`. A brand directory without its own `network.json` (for example `blue_dot/upsdm`) uses its parent's. A catalogue is the notification-service (NS) copy for that network: the email templates (with the network's brand colour), the WhatsApp `welcome` template, and the delivery policies for every domain and event the network can produce. Brand directories (for example `purple_dot/alimco`) carry the same shape with the brand's messages layered over the network's.

Catalogues are a seed. NS loads them only where a template or policy is absent, so copy that already exists in NS is left as it is. Live copy is edited through the NS admin API.

Generate the files from Signals' current email copy and `network.json` by running this in the signals-dpg repo:

```bash
pnpm --filter ns-catalogue generate <path-to-bluedots-schemas>
```

Commit the regenerated files here. The command prints any copy keys it could not place and any directory that borrows its parent's `network.json`. Output is deterministic: re-running without input changes leaves the files unchanged except the `version` stamp, which defaults to `<schemas HEAD sha>-<date>`. Pass `--version <v>` to pin it.

Guardian OTP policies name the SMS `login_otp` template alongside their email template. Configure `login_otp` for the active SMS vendor before the first NS boot that loads `NS_SEED_FILE`: `SMS_LOGIN_OTP_TEMPLATE_ID` for msg91, or `PINNACLE_LOGIN_OTP_TEMPLATE_ID` together with `SMS_LOGIN_OTP_BODY` for pinnacle. On a cluster where it was configured later, publish the guardian policy drafts through `/v1/admin/policies`. This applies to every cluster that sends guardian OTP, by email or SMS.
