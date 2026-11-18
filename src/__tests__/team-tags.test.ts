import { describe, expect, it } from 'vitest';
import { mentions, tagsForText } from '../services/team-tags.js';

describe('mentions', () => {
  it('matches whole words only', () => {
    expect(mentions('The Lakers won', 'lakers')).toBe(true);
    expect(mentions('Lakers', 'lakers')).toBe(true);
    expect(mentions('Lakersville', 'lakers')).toBe(false);
    expect(mentions('nba finals', 'nba')).toBe(true);
    expect(mentions('unbalanced', 'nba')).toBe(false);
  });

  it('is case-insensitive and regex-safe', () => {
    expect(mentions('FORMULA 1 returns', 'formula 1')).toBe(true);
    expect(mentions('a.b', 'a.b')).toBe(true);
    expect(mentions('axb', 'a.b')).toBe(false);
  });
});

describe('tagsForText', () => {
  it('tags the Sierra Leone Premier League and its clubs', () => {
    expect(tagsForText('Bo Rangers hold Leone Stars in Freetown derby', null)).toEqual([
      'team:bo-rangers',
      'team:leone-stars',
    ]);
    expect(tagsForText('SLPL round-up: East End Lions win', '')).toEqual(['league:spl', 'team:east-end-lions']);
  });

  it('keeps the Sierra Leone Premier League out of the English one', () => {
    // The generic alias would otherwise tag both competitions.
    expect(tagsForText('Sierra Leone Premier League title race', null)).toEqual(['league:spl']);
    expect(tagsForText('Premier League: Arsenal go top', null)).toEqual(['league:epl']);
  });

  it('adds the merged European section alongside a member league', () => {
    expect(tagsForText('La Liga: Real Madrid win', null)).toEqual(['league:european-leagues', 'league:la-liga']);
    expect(tagsForText('Bundesliga title decided', null)).toEqual(['league:bundesliga', 'league:european-leagues']);
  });

  it('tags US leagues and the Lakers', () => {
    expect(tagsForText('Lakers edge Celtics in NBA classic', null)).toEqual(['league:nba', 'team:lal']);
  });

  it('returns nothing for stories without a followable subject', () => {
    expect(tagsForText('Budget speech postponed', null)).toEqual([]);
    expect(tagsForText(null, undefined)).toEqual([]);
    expect(tagsForText('   ', '  ')).toEqual([]);
  });

  it('reads the summary as well as the headline', () => {
    expect(tagsForText('Port expansion wins backing', 'The Leone Stars will play a friendly.')).toEqual([
      'team:leone-stars',
    ]);
  });
});
