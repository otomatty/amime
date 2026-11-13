import { app } from "./app.ts";

export { PageDO } from "./durable-objects/page-do.ts";
export { ProjectDO } from "./durable-objects/project-do.ts";

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Cloudflare.Env>;
