/**
 * Team and league tags for the follow digest.
 *
 * A reader can follow a competition (`league:spl`) or a team (`team:leone-stars`)
 * in the app, which subscribes them to `slnews_<follow id>`. For an alert to
 * reach them, the API has to say which of those subjects a story is about — the
 * scraped feeds do not carry that metadata.
 *
 * Tags are derived from the headline and summary at read time. That keeps the
 * database schema untouched and lets the vocabulary change without a migration,
 * at the cost of a regex scan over at most 100 short strings per request.
 *
 * Precision beats recall here: a false positive pushes an alert to a reader who
 * follows an unrelated team, while a miss only leaves that story untagged. The
 * vocabulary is therefore limited to subjects a reader can actually follow, with
 * aliases that are unambiguous in a news headline.
 */

export interface SubjectTag {
  /** Follow id the app uses (`team:lal`, `league:spl`). */
  id: string;
  /** Listed for readability in tests and future diagnostics. */
  label: string;
  /** Lower-case phrases; a phrase match is a whole-word match. */
  aliases: string[];
  /**
   * Phrases that veto this tag when present in the same text. Used for the
   * "Sierra Leone Premier League" / "Premier League" overlap.
   */
  unless?: string[];
}

export const SUBJECT_TAGS: SubjectTag[] = [
  // Sierra Leone Premier League clubs.
  {
    id: 'team:leone-stars',
    label: 'Leone Stars',
    aliases: ['leone stars', 'sierra leone national team'],
  },
  { id: 'team:bo-rangers', label: 'Bo Rangers', aliases: ['bo rangers'] },
  { id: 'team:east-end-lions', label: 'East End Lions', aliases: ['east end lions'] },
  { id: 'team:kamboi-eagles', label: 'Kamboi Eagles', aliases: ['kamboi eagles'] },
  { id: 'team:blackpool', label: 'Blackpool', aliases: ['blackpool fc'] },
  {
    id: 'team:lal',
    label: 'Los Angeles Lakers',
    aliases: ['lakers', 'los angeles lakers'],
  },

  // Competitions a reader can follow.
  { id: 'league:nba', label: 'NBA', aliases: ['nba'] },
  { id: 'league:nfl', label: 'NFL', aliases: ['nfl'] },
  { id: 'league:mlb', label: 'MLB', aliases: ['mlb'] },
  { id: 'league:nhl', label: 'NHL', aliases: ['nhl'] },
  {
    id: 'league:epl',
    label: 'Premier League',
    aliases: ['premier league', 'epl'],
    // The Sierra Leone Premier League is its own competition.
    unless: ['sierra leone premier league', 'slpl'],
  },
  {
    id: 'league:champions-league',
    label: 'UEFA Champions League',
    aliases: ['champions league', 'uefa champions league'],
  },
  {
    id: 'league:spl',
    label: 'Sierra Leone Premier League',
    aliases: ['sierra leone premier league', 'slpl'],
  },
  {
    id: 'league:afcon',
    label: 'AFCON Qualifier',
    aliases: ['afcon', 'africa cup of nations'],
  },
  { id: 'league:f1', label: 'Formula 1', aliases: ['formula 1', 'formula one'] },
  {
    id: 'league:tennis',
    label: 'Tennis',
    aliases: ['tennis', 'wimbledon', 'us open tennis', 'atp tour', 'wta tour'],
  },
  { id: 'league:cricket', label: 'Cricket', aliases: ['cricket'] },
  { id: 'league:golf', label: 'Golf', aliases: ['golf', 'pga tour'] },
  {
    id: 'league:la-liga',
    label: 'La Liga',
    aliases: ['la liga'],
  },
  { id: 'league:serie-a', label: 'Serie A', aliases: ['serie a'] },
  { id: 'league:bundesliga', label: 'Bundesliga', aliases: ['bundesliga'] },
  { id: 'league:ligue-1', label: 'Ligue 1', aliases: ['ligue 1'] },
];

/** Competitions whose members are merged into one follow id in the app. */
const MERGED_PARENT = 'league:european-leagues';
const MERGED_MEMBERS = new Set(['league:la-liga', 'league:serie-a', 'league:bundesliga', 'league:ligue-1']);

/** Escapes a phrase for use in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive phrase match.
 *
 * Hyphenated aliases match their spaced form too (`serie-a` style ids are not
 * used as aliases, but publishers write "Premier League" and "Serie A").
 */
export function mentions(text: string, phrase: string): boolean {
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}([^\\p{L}\\p{N}]|$)`, 'iu');
  return pattern.test(text);
}

/**
 * Follow ids a story is about.
 *
 * A La Liga headline yields both `league:la-liga` and `league:european-leagues`,
 * because the app keeps the merged section and its members as separate follows.
 */
export function tagsForText(title: string | null | undefined, summary: string | null | undefined): string[] {
  const text = `${title ?? ''} ${summary ?? ''}`.trim();
  if (text.length === 0) return [];

  const matched = new Set<string>();
  for (const tag of SUBJECT_TAGS) {
    if (tag.unless?.some((veto) => mentions(text, veto))) continue;
    if (tag.aliases.some((alias) => mentions(text, alias))) matched.add(tag.id);
  }

  for (const member of Array.from(matched)) {
    if (MERGED_MEMBERS.has(member)) matched.add(MERGED_PARENT);
  }

  // Stable order keeps the API payload (and its ETag-ish comparisons) stable.
  return Array.from(matched).sort();
}
