import type { EventHandler } from "@/lib/event-log/dispatcher";
import {
  PROSPECTING_SITE_QUALITY_CONSUMER_KEY,
  analyzeProspectSiteQuality,
} from "@/workers/prospecting-site-quality-worker";

export const prospectingSiteQualityHandler: EventHandler = {
  key: PROSPECTING_SITE_QUALITY_CONSUMER_KEY,
  events: ["prospected_place.site_quality_requested"],
  handle: analyzeProspectSiteQuality,
};
