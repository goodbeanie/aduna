'use strict';
// Words Contexto keeps out of sight. The vocabulary is common English, so it includes swears, slurs, sexual words and names tied to real
// crimes or politics. Two tiers:
//   hidden(w)   never the secret word, never a hint, never in the "closest words" list (everything below).
//   rejected(w) also not accepted as a guess ("isn't in Contexto's list"): swears, slurs and explicit sexual words only. Milder words
//               such as nuts, hell or kill can still be guessed, because they have ordinary meanings and people will try them.
// The word vectors are indexed by position, so words are skipped here instead of deleted from contexto-data/ (that would shift every rank).
// Add a word to a list and it is gone everywhere on the next deploy.

// Stems that are never part of an ordinary word, so a substring check is safe (it also catches fucking, shitty, bitches ...)
const STEMS = /fuck|shit|cunt|nigg|fagg|bitch|whore|slut|dildo|pedo|porn|wank|bollock|twat|pussy|jizz|blowjob|handjob|motherf|dickhead|asshole|arsehole|bullshit|horny|boner|jerkoff|cumshot/;

const list = (s) => s.split(/\s+/).filter(Boolean);

// swears, slurs, explicit sexual words, sexual violence: rejected as guesses AND hidden
const HARD = new Set(list(
  'ass arse cock cocks dick dicks tit tits titty boob boobs prick douche douchebag turd ' +
  'cum cums cumming sperm semen penis vagina anal anus clit clitoris scrotum orgasm orgasms erotic erotica sex sexy sexual sexually kinky fetish bdsm ' +
  'hooker hookers prostitute prostitutes prostitution brothel stripper strippers striptease slutty hentai masturbate masturbation intercourse genital genitals nude nudes nudity naked ' +
  'fag fags faggot faggots dyke retard retarded retards spic chink gook kike coon negro negroes tranny homo homos wetback honky sambo ' +
  'rape raped raping rapist rapists molest molested molester molestation pedophile pedophiles pedophilia incest paedophile ' +
  'nazi nazis nazism hitler swastika kkk ' +
  'diddy epstein weinstein cosby'
));

// hidden only: guessable, but never the answer, a hint or a closest word
const SOFT = new Set(list(
  'damn damned dammit hell crap piss pissed pissing butt butts balls nuts bastard bastards fart farts farting poop poops screw screwed sexist lust lustful playboy escort escorts mistress grope groped trafficking ' +
  'fascist fascism fascists klan supremacist supremacists holocaust genocide genocides massacre massacres lynching lynched terrorist terrorists terrorism isis alqaeda jihad jihadist ' +
  'slavery slave slaves segregation apartheid gulag auschwitz gypsy gypsies cracker redneck ' +
  'suicide suicidal suicides kill killing killer killers murder murdered murderer murderers homicide ' +
  'abortion abortions trump biden obama clinton hillary putin stalin lenin mao kim maxwell kanye ' +
  'maga democrat democrats republican republicans liberal liberals conservative conservatives leftist communist communists communism socialist socialism ' +
  'transgender gay lesbian bisexual homosexual homosexuality lgbt lgbtq ' +
  'allah jesus christ muhammad mohammed jehovah satan satanic lucifer devil demon demons ' +
  'cocaine heroin meth methamphetamine crack opium fentanyl lsd ecstasy mdma weed marijuana cannabis dope stoned junkie junkies overdose'
));

const rejected = (w) => typeof w === 'string' && (HARD.has(w) || STEMS.test(w));
const hidden = (w) => typeof w === 'string' && (rejected(w) || SOFT.has(w));

module.exports = { hidden, rejected, HARD, SOFT, STEMS };
