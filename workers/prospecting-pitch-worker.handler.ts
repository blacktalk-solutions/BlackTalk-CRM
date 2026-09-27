import type { EventHandler } from "@/lib/event-log/dispatcher";
import { PROSPECTING_PITCH_CONSUMER_KEY, generateProspectPitch } from "@/workers/prospecting-pitch-worker";

export const prospectingPitchHandler: EventHandler = {
  key: PROSPECTING_PITCH_CONSUMER_KEY,
  events: ["prospected_place.pitch_requested"],
  handle: generateProspectPitch,
};
