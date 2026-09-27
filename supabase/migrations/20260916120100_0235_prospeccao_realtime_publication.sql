/**
 * Migration 0235: Add prospected_places to Realtime publication
 *
 * Critical #1: prospected_places was not added to the supabase_realtime publication,
 * so client Realtime subscriptions (postgres_changes) would never fire updates.
 *
 * This must be done after the table is created (migration 0234) but before any
 * client code tries to subscribe to real-time changes on prospected_places.
 */

alter publication supabase_realtime add table public.prospected_places;
