/**
 * Shape of one entry in fb_posts.metadata.participants (see docs/SPEC.md
 * §4.2). Only the fields actually read anywhere in the codebase — metadata
 * carries more (is_pb, UM_count, foreign_count) that nothing consumes yet.
 */
export interface ParticipantStats {
  distance_km?: number | null;
  FM_count?: number | null;
  HM_count?: number | null;
}

export interface Participant {
  name?: string;
  distance?: string;
  time?: string;
  stats?: ParticipantStats;
}
