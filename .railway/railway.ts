import { defineRailway, preserve, project, service } from "railway/iac";

// Applied only by `railway config apply` (Railway doesn't read this file during deploys).
// It owns only virvi-server (renamed from vlm-server at rollout R6; apply only after that rename); Postgres and its volume stay managed in the dashboard. // virvi-rename: keep
// Every variable must be listed here (preserve() keeps the value set in Railway), or the next apply deletes it:
// after adding a variable in the dashboard, add it below, and always run `railway config plan` before applying.
export const partial = "virvi-server";

export default defineRailway(() => {
  const virviServer = service("virvi-server", {
    start: "apps/server/entrypoint.sh",
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    replicas: 1,
    env: { ANDROID_CERT_SHA256: preserve(), AWS_ACCESS_KEY_ID: preserve(), AWS_SECRET_ACCESS_KEY: preserve(), CDN_URL: preserve(), CORS_ORIGINS: preserve(), DATABASE_URL: preserve(), FLY_API_TOKEN: preserve(), FLY_WORLDS_ORG: preserve(), GIVEAWAY_GAS_KEY: preserve(), GIVEAWAY_GAS_TANK_MIN_POL: preserve(), GIVEAWAY_JOB_EVERY_MS: preserve(), GIVEAWAY_WALLET_SECRET: preserve(), HLS_BASE_URL: preserve(), HYPERFY_ASSETS_BASE_URL: preserve(), HYPERFY_ASSETS_S3_URI: preserve(), HYPERFY_DB_JOB_APP: preserve(), HYPERFY_IMAGE: preserve(), HYPERFY_INFRA_PROVIDER: preserve(), HYPERFY_ROUTER_DOMAIN: preserve(), HYPERFY_SECRET_KEY: preserve(), HYPERFY_WORLDS_DATABASE_URL: preserve(), HYPERFY_WORLDS_DB_MODE: preserve(), HYPERFY_WORLDS_DB_URL_TEMPLATE: preserve(), JWT_SECRET: preserve(), LOCAL_STORAGE_PATH: preserve(), NEXT_PUBLIC_API_URL: preserve(), NEXT_PUBLIC_WSS_URL: preserve(), PUBLIC_URL: preserve(), RTMP_INGEST_URL: preserve(), S3_BUCKET: preserve(), S3_ENDPOINT: preserve(), S3_REGION: preserve(), STORAGE_PROVIDER: preserve(), STREAMING_WEBHOOK_KEY: preserve(), STRIPE_SECRET_KEY: preserve(), STRIPE_WEBHOOK_SECRET: preserve(), VIRVI_DCL_DEPLOY_KEY: preserve(), VIRVI_MODE: preserve(), WEB_APP_URL: preserve() },
  });
  return project("Virvi", {
    resources: [virviServer],
  });
});
