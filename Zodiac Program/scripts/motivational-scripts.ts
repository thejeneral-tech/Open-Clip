/**
 * Cinematic Motivational Scripts — Built-in Library
 * ─────────────────────────────────────────────────────────────────────────────
 * 12 hand-written passionate motivational scripts (one per zodiac sign) in the
 * Hook / Observation / Energy Shift / Strength / Motivation / Deep Truth /
 * Ending structure. They are wired into the script-generation pipeline as a
 * built-in fallback / library. The frontend doesn't expose them as a separate
 * UI option — they're available silently to any caller that:
 *   - requests `emotionalTone: 'motivational'`
 *   - hits the fallback path with no prompt and a known sign
 *   - imports `getMotivationalScript()` directly
 *
 * Section → existing line type mapping:
 *   HOOK         → 'hook'
 *   OBSERVATION  → 'observation'
 *   ENERGY SHIFT → 'escalation'
 *   STRENGTH     → 'observation'
 *   MOTIVATION   → 'twist'      (the empowering pivot)
 *   DEEP TRUTH   → 'truth'
 *   ENDING       → 'ending'
 */

import type { GeneratedLine, GeneratedScript } from './zodiac-generate';

// Quick line factory — keeps the data dense + readable
const L = (
  text: string,
  type: GeneratedLine['type'],
  durationSeconds: number,
): GeneratedLine => ({ text, type, durationSeconds });

export const MOTIVATIONAL_SCRIPTS: Record<string, GeneratedLine[]> = {
  Aries: [
    L("You forgot how loud your fire used to be.", 'hook', 3.0),
    L("Aries — it's coming back.", 'hook', 2.5),
    L("You spent years being patient with people who never matched your speed.", 'observation', 4.5),
    L("You started believing your energy was too much.", 'observation', 3.5),
    L("It wasn't.", 'observation', 2.0),
    L("It was just early.", 'observation', 2.5),
    L("A new chapter is opening for you right now.", 'escalation', 3.5),
    L("The hesitation that's been sitting in your chest is about to break.", 'escalation', 4.5),
    L("Movement is finding you again — and this time, you don't have to apologize for any of it.", 'escalation', 5.5),
    L("You were never reckless.", 'observation', 2.5),
    L("You were always the first to feel the truth before anyone else could see it.", 'observation', 4.5),
    L("Stop waiting for permission to begin.", 'twist', 3.0),
    L("You are the one you've been waiting on.", 'twist', 3.5),
    L("This phase isn't about winning.", 'truth', 3.0),
    L("It's about remembering you were never small.", 'truth', 4.0),
    L("The fire never left you, Aries.", 'ending', 3.5),
    L("It was just learning to burn smarter.", 'ending', 4.0),
  ],

  Taurus: [
    L("You've been planting seeds nobody saw.", 'hook', 3.5),
    L("Taurus — they're about to grow louder than your doubts.", 'hook', 4.0),
    L("You don't move until you're sure.", 'observation', 3.0),
    L("And the world has rushed you, mocked you, told you to hurry.", 'observation', 4.5),
    L("But everything you've built, you built to last.", 'observation', 4.0),
    L("Something steady is finding you now.", 'escalation', 3.5),
    L("The kind of stability that doesn't shake.", 'escalation', 3.5),
    L("The kind of love, money, and peace that arrives slowly — and stays.", 'escalation', 5.0),
    L("You are patient where others panic.", 'observation', 3.5),
    L("You are loyal where others leave.", 'observation', 3.0),
    L("You are proof that softness and strength can live in the same body.", 'observation', 5.0),
    L("Don't talk yourself out of what you've earned.", 'twist', 4.0),
    L("You are allowed to keep good things.", 'twist', 3.5),
    L("This phase isn't a reward — it's a recognition.", 'truth', 4.0),
    L("The universe has been watching you stay consistent. And it remembers.", 'truth', 5.0),
    L("You weren't slow, Taurus.", 'ending', 3.0),
    L("You were building the only thing that lasts.", 'ending', 4.5),
  ],

  Gemini: [
    L("You've been living between two versions of yourself for too long.", 'hook', 4.5),
    L("Gemini — one of them is ready to be released.", 'hook', 4.0),
    L("You feel everything in stereo.", 'observation', 3.0),
    L("The room's mood, the unspoken question, the future already arriving.", 'observation', 5.0),
    L("It's exhausting to be this aware.", 'observation', 3.5),
    L("The fog is lifting.", 'escalation', 2.5),
    L("You are entering a season where your mind finally agrees with your heart.", 'escalation', 5.0),
    L("Where what you say matches what you feel matches what you do.", 'escalation', 5.0),
    L("Your intelligence is not a trick.", 'observation', 3.0),
    L("It is a gift you've been quietly hiding so other people could feel comfortable.", 'observation', 5.0),
    L("Stop dimming your mind for rooms that can't hold it.", 'twist', 4.0),
    L("The right people aren't looking for less of you.", 'twist', 4.0),
    L("Your scattered years weren't wasted.", 'truth', 3.5),
    L("You were collecting every angle you'd one day need.", 'truth', 4.5),
    L("The version of you that knows what it wants — she's already inside.", 'ending', 4.5),
    L("Let her speak.", 'ending', 3.0),
  ],

  Cancer: [
    L("You don't owe softness to people who never gave it back.", 'hook', 4.5),
    L("Cancer — your peace is no longer a debate.", 'hook', 3.5),
    L("You've spent your life carrying everyone else's storms.", 'observation', 4.5),
    L("Holding people who couldn't hold themselves.", 'observation', 4.0),
    L("Loving so quietly it looked like silence.", 'observation', 4.0),
    L("A new emotional season is finding you.", 'escalation', 3.5),
    L("The kind that doesn't ask you to shrink.", 'escalation', 3.5),
    L("The kind that lets you rest without explaining why.", 'escalation', 4.0),
    L("Your sensitivity was never a flaw.", 'observation', 3.5),
    L("It is the most accurate compass in the room.", 'observation', 4.0),
    L("It has been right the whole time.", 'observation', 3.5),
    L("You are allowed to choose yourself first.", 'twist', 3.5),
    L("Even the people who love you can survive your boundary.", 'twist', 4.5),
    L("This phase isn't you becoming colder.", 'truth', 3.5),
    L("It's you becoming whole.", 'truth', 3.0),
    L("You were never too much, Cancer.", 'ending', 3.5),
    L("You were just finally listened to — by yourself.", 'ending', 4.5),
  ],

  Leo: [
    L("You stopped performing.", 'hook', 2.5),
    L("Leo — the world is finally seeing the real you.", 'hook', 4.0),
    L("For years, you were loud so no one would notice you were lonely.", 'observation', 5.0),
    L("You smiled so no one would ask the harder question.", 'observation', 4.5),
    L("Somewhere along the way, you forgot the difference between being watched and being known.", 'observation', 5.5),
    L("That changes now.", 'escalation', 2.0),
    L("You are stepping into a season of authentic recognition.", 'escalation', 4.5),
    L("The people, the rooms, the opportunities that meet you next — they will see who you actually are.", 'escalation', 5.5),
    L("Your warmth is rare.", 'observation', 2.5),
    L("Your courage is generational.", 'observation', 3.0),
    L("And the way you make ordinary moments feel important — that is a kind of magic.", 'observation', 5.0),
    L("You don't have to earn your light.", 'twist', 3.5),
    L("You are allowed to be admired without performing for it.", 'twist', 4.5),
    L("This phase isn't about being chosen.", 'truth', 3.5),
    L("It's about choosing yourself loud enough that the right people hear it.", 'truth', 5.0),
    L("The spotlight was never the goal, Leo.", 'ending', 4.0),
    L("The truth was. And now — you are it.", 'ending', 4.0),
  ],

  Virgo: [
    L("You've been the one who fixes everything.", 'hook', 3.5),
    L("Virgo — you don't have to anymore.", 'hook', 3.5),
    L("You analyze, you anticipate, you carry the weight no one else even noticed.", 'observation', 5.5),
    L("You apologize for needing help.", 'observation', 3.5),
    L("You correct yourself before anyone has the chance.", 'observation', 4.0),
    L("A softer chapter is finding you.", 'escalation', 3.5),
    L("Where rest doesn't require productivity.", 'escalation', 3.5),
    L("Where you stop counting your worth in tasks completed.", 'escalation', 4.5),
    L("Your discipline is unmatched.", 'observation', 3.0),
    L("Your attention to detail is a love language other people couldn't speak if they tried.", 'observation', 5.5),
    L("You are proof that consistency is its own kind of brilliance.", 'observation', 4.5),
    L("Stop earning what was already yours.", 'twist', 3.5),
    L("You don't owe the world a perfect version of yourself.", 'twist', 4.5),
    L("This phase is not about doing more.", 'truth', 3.5),
    L("It's about realizing you've already been enough.", 'truth', 4.0),
    L("You can stop now, Virgo.", 'ending', 3.0),
    L("The work was always good. And so were you.", 'ending', 4.0),
  ],

  Libra: [
    L("You've kept everyone balanced except yourself.", 'hook', 4.0),
    L("Libra — that ends here.", 'hook', 2.5),
    L("You read every room before entering it.", 'observation', 3.5),
    L("You feel everyone's discomfort before they do.", 'observation', 4.0),
    L("And in the process, you forgot what you needed.", 'observation', 4.0),
    L("A bolder version of you is being born.", 'escalation', 3.5),
    L("One that no longer translates her needs into apologies.", 'escalation', 4.5),
    L("One that says no without softening the sound of it.", 'escalation', 4.5),
    L("Your fairness is not weakness.", 'observation', 3.0),
    L("Your peace is not avoidance.", 'observation', 3.0),
    L("Your kindness is not naivety.", 'observation', 3.0),
    L("You see people clearly — and choose grace anyway.", 'observation', 4.5),
    L("Don't water yourself down to keep the peace.", 'twist', 4.0),
    L("Real harmony includes you.", 'twist', 3.0),
    L("This phase isn't about confrontation.", 'truth', 3.5),
    L("It's about you finally being on your own side.", 'truth', 4.0),
    L("The scales were always meant to balance you too, Libra.", 'ending', 4.5),
    L("Tip them.", 'ending', 2.5),
  ],

  Scorpio: [
    L("You've been quiet for a reason.", 'hook', 3.0),
    L("Scorpio — you were rebuilding.", 'hook', 3.0),
    L("You died a little this year.", 'observation', 3.0),
    L("Not all of it was visible.", 'observation', 3.0),
    L("You let parts of yourself go that no one knew you were carrying.", 'observation', 5.0),
    L("Something is rising in you now.", 'escalation', 3.5),
    L("A version with sharper instincts.", 'escalation', 3.5),
    L("A version that doesn't waste a single ounce of feeling on people who can't handle it.", 'escalation', 5.5),
    L("Your depth is your power.", 'observation', 3.0),
    L("Your loyalty is rare currency.", 'observation', 3.5),
    L("Your ability to sit with the truth — even when it costs you — is the reason you survive things others don't.", 'observation', 6.0),
    L("Stop dimming the intensity.", 'twist', 3.0),
    L("The people meant for you can stand in your fire.", 'twist', 4.5),
    L("This phase isn't transformation.", 'truth', 3.0),
    L("It's the version of you that always existed — finally allowed to come up for air.", 'truth', 5.5),
    L("The dark was the work, Scorpio.", 'ending', 3.5),
    L("This is the rising.", 'ending', 3.0),
  ],

  Sagittarius: [
    L("The restlessness you've been feeling isn't a flaw.", 'hook', 4.0),
    L("Sagittarius — it's a signal.", 'hook', 3.0),
    L("You've spent so much time chasing meaning that it started to feel like running.", 'observation', 5.5),
    L("But you weren't running away.", 'observation', 3.0),
    L("You were searching for the version of life that actually fits you.", 'observation', 5.0),
    L("The search is sharpening into a direction.", 'escalation', 3.5),
    L("The doors that close in this season aren't punishments.", 'escalation', 4.5),
    L("They're rerouting you toward something more honest.", 'escalation', 4.5),
    L("Your optimism is harder than people realize.", 'observation', 4.0),
    L("You've turned every disappointment into a story you can carry.", 'observation', 5.0),
    L("You believe in possibility — and that belief is contagious.", 'observation', 4.5),
    L("Stop apologizing for needing more than people understand.", 'twist', 4.5),
    L("You weren't built for small lives.", 'twist', 3.5),
    L("This phase isn't a detour.", 'truth', 3.0),
    L("It's the moment your freedom and your purpose finally meet.", 'truth', 4.5),
    L("You weren't lost, Sagittarius.", 'ending', 3.5),
    L("You were aiming.", 'ending', 2.5),
  ],

  Capricorn: [
    L("The years you spent climbing in silence are about to speak.", 'hook', 5.0),
    L("Capricorn — the harvest is real.", 'hook', 3.5),
    L("You've been the one holding it all together.", 'observation', 4.0),
    L("You worked when no one was watching.", 'observation', 3.5),
    L("You stayed when staying didn't pay yet.", 'observation', 4.0),
    L("A new chapter of return is opening.", 'escalation', 3.5),
    L("The discipline you've poured into your craft, your relationships, your future — it's coming back to you.", 'escalation', 6.0),
    L("Not all at once. But unmistakably.", 'escalation', 3.5),
    L("Your patience is a kind of wealth.", 'observation', 3.5),
    L("Your consistency is a kind of magic.", 'observation', 3.5),
    L("Your ability to plan in years instead of weeks — that is how legacies are built.", 'observation', 5.5),
    L("Don't shrink the moment when it arrives.", 'twist', 3.5),
    L("You earned every second of this.", 'twist', 3.5),
    L("This phase isn't luck.", 'truth', 2.5),
    L("It's interest accruing on every quiet decision you ever made.", 'truth', 5.0),
    L("The mountain remembers, Capricorn.", 'ending', 3.5),
    L("And so does the universe.", 'ending', 3.0),
  ],

  Aquarius: [
    L("You've been ten years ahead of everyone — quietly.", 'hook', 4.5),
    L("Aquarius — the world is finally arriving.", 'hook', 3.5),
    L("You've watched ideas you had years ago show up in other people's mouths.", 'observation', 5.0),
    L("You've been told you were strange, then called a visionary by the same people.", 'observation', 5.5),
    L("You learned to keep the best parts of yourself hidden.", 'observation', 4.5),
    L("That ends.", 'escalation', 2.0),
    L("A season is opening where your unusual mind becomes your edge.", 'escalation', 5.0),
    L("Where the rooms that ignored you start asking for the very thing they used to dismiss.", 'escalation', 5.5),
    L("Your independence is not coldness.", 'observation', 3.5),
    L("Your detachment is clarity.", 'observation', 3.0),
    L("Your ability to imagine futures other people can't even describe — that is not eccentricity. That is prophecy.", 'observation', 6.5),
    L("Don't translate yourself anymore.", 'twist', 3.0),
    L("The right rooms speak your language.", 'twist', 3.5),
    L("This phase isn't about belonging.", 'truth', 3.0),
    L("It's about being recognized for the very thing you almost stopped sharing.", 'truth', 5.0),
    L("You were always early, Aquarius.", 'ending', 3.5),
    L("The world is just catching up.", 'ending', 3.5),
  ],

  Pisces: [
    L("The world tried to harden you.", 'hook', 3.0),
    L("Pisces — you refused.", 'hook', 2.5),
    L("You feel things at frequencies most people will never reach.", 'observation', 4.5),
    L("You've been told you're too sensitive, too dreamy, too much.", 'observation', 4.5),
    L("You started believing it.", 'observation', 2.5),
    L("A different season is finding you.", 'escalation', 3.5),
    L("One where your softness is no longer a target.", 'escalation', 4.0),
    L("One where the depth you've protected becomes the reason people trust you.", 'escalation', 5.0),
    L("Your intuition is the most accurate thing in any room.", 'observation', 4.5),
    L("Your empathy is a generational inheritance.", 'observation', 4.0),
    L("Your ability to love without becoming bitter — that is rare and holy.", 'observation', 5.0),
    L("Stop trying to be less of what you naturally are.", 'twist', 4.0),
    L("The version of you the world told you to bury — that is the one that changes everything.", 'twist', 5.5),
    L("This phase isn't you becoming someone new.", 'truth', 3.5),
    L("It's you finally trusting the someone you've always been.", 'truth', 4.5),
    L("Your softness was never your weakness, Pisces.", 'ending', 4.5),
    L("It was your map home.", 'ending', 3.0),
  ],
};

/**
 * Look up a built-in motivational script by sign.
 * Returns null if the sign isn't in the library (e.g. a typo or custom sign).
 */
export function getMotivationalScript(zodiacSign: string): GeneratedScript | null {
  const lines = MOTIVATIONAL_SCRIPTS[zodiacSign];
  if (!lines || lines.length === 0) return null;
  const totalDuration = lines.reduce((sum, l) => sum + l.durationSeconds, 0);
  return {
    lines,
    totalDuration,
    title: `${zodiacSign} — A Cinematic Motivational Reading`,
    hook: lines[0]?.text ?? '',
    zodiacSign,
    topic: 'motivational',
    emotionalTone: 'motivational',
  };
}

/**
 * Returns true when the caller is asking for a motivational tone or has not
 * given the AI generator anything specific to work with. Used by the fallback
 * path in `zodiac-generate.ts` to pick this library over the generic fallback.
 */
export function shouldUseMotivationalScript(opts: {
  zodiacSign: string;
  emotionalTone?: string;
  prompt?: string;
}): boolean {
  if (!MOTIVATIONAL_SCRIPTS[opts.zodiacSign]) return false;
  const tone = (opts.emotionalTone || '').toLowerCase();
  if (tone === 'motivational' || tone === 'positive' || tone === 'cinematic') return true;
  // If there's no real prompt to work with, motivational is a strong default
  if (!opts.prompt || opts.prompt.trim().length < 6) return true;
  return false;
}
