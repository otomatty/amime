import { app } from "./app.ts";

export { PageDO } from "./durable-objects/page-do.ts";

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Cloudflare.Env>;
