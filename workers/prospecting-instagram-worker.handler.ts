import type { EventHandler } from "@/lib/event-log/dispatcher";
import {
  PROSPECTING_INSTAGRAM_CONSUMER_KEY,
  enrichProspectInstagram,
} from "@/workers/prospecting-instagram-worker";

export const prospectingInstagramHandler: EventHandler = {
  key: PROSPECTING_INSTAGRAM_CONSUMER_KEY,
  events: ["prospected_place.instagram_requested"],
  handle: enrichProspectInstagram,
};
