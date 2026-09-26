import type { EventHandler } from "@/lib/event-log/dispatcher";
import { PROSPECTING_CNPJ_CONSUMER_KEY, enrichProspectCnpj } from "@/workers/prospecting-cnpj-worker";

export const prospectingCnpjHandler: EventHandler = {
  key: PROSPECTING_CNPJ_CONSUMER_KEY,
  events: ["prospected_place.cnpj_requested"],
  handle: enrichProspectCnpj,
};
