// The rating arithmetic, with nothing else attached.
//
// Split out from the service so the recommendation engines can rank on the
// same numbers customers are shown without importing the database along with
// them. Those engines are deliberately pure and their tests run without a
// Prisma client; a transitive import would have quietly taken that away.

export type CommunityRating = { average: number; count: number };

/** Ratings needed before the crowd fully outweighs the catalogue baseline. */
export const CONFIDENCE_AT = 10;

/**
 * Blends a catalogue baseline with what customers actually said.
 *
 * With few ratings we mostly trust the baseline, with many we mostly trust the
 * crowd, so one angry review cannot sink a dish and a genuinely bad one still
 * drifts down. This is the shrinking step, and the baseline is the prior:
 * stable, external, and not something a thin average can move.
 *
 * Rounded to one decimal, which is how a rating is displayed.
 */
export function blendRating(
  baseline: number,
  community: CommunityRating | undefined,
): number {
  if (!community || community.count === 0) return baseline;
  const w = Math.min(1, community.count / CONFIDENCE_AT);
  const blended = baseline * (1 - w) + community.average * w;
  return Math.round(blended * 10) / 10;
}

/**
 * What a ranker needs about one option's quality: the number to rank on, and
 * how much evidence stands behind it.
 *
 * The count is reported as zero rather than left absent when nobody has rated
 * the option. An absent count switches confidence weighting off for the entire
 * result set, so a silent gap here would quietly disable it everywhere.
 */
export function qualityOf(
  baseline: number,
  community: CommunityRating | undefined,
): { rating: number; ratingCount: number } {
  return {
    rating: blendRating(baseline, community),
    ratingCount: community?.count ?? 0,
  };
}
