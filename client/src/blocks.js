// The block editor for bots: Scratch-style blocks (Blockly) that GENERATE the same JavaScript a hand-written bot is made of.
// The server never sees blocks as anything but a saved layout: what runs is the generated code, in the same sandbox, under the same checks
// (see server/bots.js). Everything Blockly lives in this one file, so the editor can load it only when someone opens the block editor.
//
//   injectEditor(container, { initial, onChange, readOnly }) -> { ws, dispose, ... }   the editor (browser only)
//   generate(ws) / codeFromLayout(json)                       blocks -> JavaScript (also works without a screen: client/scripts/blocks-test.mjs)
//   startLayout()                                             what a new block bot starts with (the same bot as the JavaScript starter)
//
// Every handler is `bot.on('<event>', (ev) => { ... })` and the blocks inside read `ev` (the event: a message, someone joining, a timer...).
import * as Blockly from 'blockly';
import { javascriptGenerator as gen, Order } from 'blockly/javascript';

export const COLORS = { events: '#E6A800', chat: '#4C97FF', data: '#CF63CF', timers: '#5CB1D6', web: '#0FBD8C', control: '#FFAB19', ops: '#59C059', lists: '#FF8C4C', vars: '#FF661A' };

// ---------- blocks ----------
const stmt = { previousStatement: null, nextStatement: null };
const hat = (type, label, extra = {}) => ({ type, message0: label, message1: '%1', args1: [{ type: 'input_statement', name: 'DO' }], style: 'event_blocks', ...extra });
const nameField = (def = 'name1') => ({ type: 'field_input', name: 'NAME', text: def, spellcheck: false });
const val = (name, check) => ({ type: 'input_value', name, ...(check ? { check } : {}) });

Blockly.common.defineBlocksWithJsonArray([
  // events
  hat('bot_on_message', 'when a message is posted', { tooltip: 'Runs when someone posts in a text channel the bot can read. Blocks inside can use the message.' }),
  hat('bot_on_edit', 'when a message is edited', { tooltip: 'Runs when someone edits a message the bot can read.' }),
  hat('bot_on_join', 'when someone joins', { tooltip: 'Runs when a person joins the server.' }),
  hat('bot_on_leave', 'when someone leaves', { tooltip: 'Runs when a person leaves or is removed from the server.' }),
  hat('bot_on_install', 'when the bot is added to a server', { tooltip: 'Runs once, right after the bot is added to a server. A good place to start timers.' }),
  hat('bot_on_timer', 'when timer %1 goes off', { args0: [nameField('timer1')], extensions: ['bot_name_field'], tooltip: 'Runs when a timer with this name fires. Start timers with the Timers blocks.' }),
  hat('bot_on_web', 'when web answer %1 arrives', { args0: [nameField('answer1')], extensions: ['bot_name_field'], tooltip: 'Runs when the web request with this name has been answered.' }),

  // chat: things the bot does
  { type: 'bot_reply', message0: 'reply %1', args0: [val('TEXT')], ...stmt, colour: COLORS.chat, tooltip: 'Answers the message that started this. Only works under "when a message is posted" or "edited".' },
  { type: 'bot_send', message0: 'send message %1', args0: [val('TEXT')], ...stmt, colour: COLORS.chat, tooltip: 'Posts in the channel the event came from (or the first channel the bot may write in).' },
  { type: 'bot_react', message0: 'react with %1', args0: [val('EMOJI')], ...stmt, colour: COLORS.chat, tooltip: 'Adds an emoji reaction to the message that started this.' },
  { type: 'bot_log', message0: 'write %1 in the run log', args0: [val('VALUE')], ...stmt, colour: COLORS.chat, tooltip: 'Shows up in "Recent runs" and in the simulator. Handy to see what a block holds.' },
  // chat: things the bot can read
  { type: 'bot_text', message0: 'message text', output: 'String', colour: COLORS.chat, tooltip: 'What the person wrote.' },
  { type: 'bot_person', message0: "the person's %1", args0: [{ type: 'field_dropdown', name: 'FIELD', options: [['display name', 'displayName'], ['username', 'username']] }], output: 'String', colour: COLORS.chat, tooltip: 'The person who wrote the message, joined or left.' },
  { type: 'bot_mention', message0: 'mention the person', output: 'String', colour: COLORS.chat, tooltip: 'A mention of the person. A bot can only ping the person it is answering.' },
  { type: 'bot_mentions_me', message0: 'message mentions the bot', output: 'Boolean', colour: COLORS.chat, tooltip: 'True when the message mentions the bot.' },
  { type: 'bot_server_name', message0: 'server name', output: 'String', colour: COLORS.chat, tooltip: 'The server the bot was just added to (only under "when the bot is added").' },

  // saved data
  { type: 'bot_store_set', message0: 'save %1 as %2', args0: [val('KEY'), val('VALUE')], ...stmt, colour: COLORS.data, tooltip: 'Remembers a value for this bot in this server, even after the event is over.' },
  { type: 'bot_store_add', message0: 'change saved %1 by %2', args0: [val('KEY'), val('BY', 'Number')], ...stmt, colour: COLORS.data, tooltip: 'Adds to a saved number (starts at 0). Good for counters.' },
  { type: 'bot_store_delete', message0: 'forget saved %1', args0: [val('KEY')], ...stmt, colour: COLORS.data, tooltip: 'Removes a saved value.' },
  { type: 'bot_store_get', message0: 'saved %1', args0: [val('KEY')], output: null, colour: COLORS.data, tooltip: 'The value saved under this name (nothing if there is none).' },

  // timers
  { type: 'bot_timer_after', message0: 'in %1 seconds start timer %2', args0: [val('SECONDS', 'Number'), nameField('timer1')], ...stmt, extensions: ['bot_name_field'], colour: COLORS.timers, tooltip: 'Fires once. At least 5 seconds. Catch it with "when timer goes off".' },
  { type: 'bot_timer_every', message0: 'every %1 seconds start timer %2', args0: [val('SECONDS', 'Number'), nameField('timer1')], ...stmt, extensions: ['bot_name_field'], colour: COLORS.timers, tooltip: 'Fires again and again. At least 60 seconds apart.' },
  { type: 'bot_timer_daily', message0: 'every day at %1 in time zone %2 start timer %3', args0: [{ type: 'field_input', name: 'TIME', text: '09:00', spellcheck: false }, { type: 'field_input', name: 'TZ', text: 'UTC', spellcheck: false }, nameField('timer1')], ...stmt, extensions: ['bot_name_field', 'bot_time_fields'], colour: COLORS.timers, tooltip: 'Time is 24 hour HH:MM. The time zone is a name like UTC, Europe/London or America/Vancouver.' },
  { type: 'bot_timer_cancel', message0: 'stop timer %1', args0: [nameField('timer1')], ...stmt, extensions: ['bot_name_field'], colour: COLORS.timers, tooltip: 'Cancels a timer that was started.' },

  // the web
  { type: 'bot_fetch', message0: 'ask the web for %1 and call it %2', args0: [val('URL'), nameField('answer1')], ...stmt, extensions: ['bot_name_field'], colour: COLORS.web, tooltip: 'Reads a public web address (only some sites are allowed). The answer arrives later under "when web answer arrives".' },
  { type: 'bot_answer', message0: 'web answer %1', args0: [{ type: 'field_dropdown', name: 'FIELD', options: [['text', 'text'], ['worked (true/false)', 'ok'], ['status number', 'status']] }], output: null, colour: COLORS.web, tooltip: 'Part of the answer. Only under "when web answer arrives".' },
  { type: 'bot_answer_value', message0: 'value %1 from the web answer', args0: [val('KEY')], output: null, colour: COLORS.web, tooltip: 'Reads a field from a JSON answer. Use dots for nested ones, like owner.login.' },

  // text helpers (the ones people need for commands)
  { type: 'bot_text_starts', message0: '%1 starts with %2', args0: [val('A'), val('B')], inputsInline: true, output: 'Boolean', colour: COLORS.ops, tooltip: 'True when the first text begins with the second, like a !command.' },
  { type: 'bot_text_contains', message0: '%1 contains %2', args0: [val('A'), val('B')], inputsInline: true, output: 'Boolean', colour: COLORS.ops, tooltip: 'True when the first text has the second somewhere inside.' },
  { type: 'bot_word', message0: 'word %1 of %2', args0: [val('N', 'Number'), val('TEXT')], inputsInline: true, output: 'String', colour: COLORS.ops, tooltip: 'The 1st, 2nd... word of a text (empty if there is none). "!roll 6" has the words !roll and 6.' },
  { type: 'bot_to_number', message0: 'number from %1', args0: [val('X')], output: 'Number', colour: COLORS.ops, tooltip: 'Turns text like "6" into the number 6.' },
  { type: 'bot_is_number', message0: '%1 is a number', args0: [val('X')], output: 'Boolean', colour: COLORS.ops, tooltip: 'True when the text is a number.' },
]);

// A timer, request or event name: letters, numbers and _ . : - (what the server accepts). Time and zone fields are cleaned the same way.
const cleanName = (v) => String(v).replace(/[^A-Za-z0-9_.:-]/g, '').replace(/^[^A-Za-z0-9]+/, '').slice(0, 32) || null;
const cleanTime = (v) => String(v).replace(/[^0-9:]/g, '').slice(0, 5);
const cleanZone = (v) => String(v).replace(/[^A-Za-z0-9_+\-/]/g, '').slice(0, 64);
const registered = (globalThis.__adunaBlockExtensions ||= new Set()); // survives a hot reload of this file, so an extension is replaced, not added twice
function register(name, fn) {
  if (registered.has(name)) { try { Blockly.Extensions.unregister(name); } catch { /* already gone */ } }
  Blockly.Extensions.register(name, fn);
  registered.add(name);
}
register('bot_name_field', function () { this.getField('NAME').setValidator(cleanName); });
register('bot_time_fields', function () { this.getField('TIME').setValidator(cleanTime); this.getField('TZ').setValidator(cleanZone); });

// ---------- code generation ----------
gen.addReservedWords('ev,bot,__ch');
const q = (s) => gen.quote_(String(s ?? ''));
const V = (b, name, order = Order.NONE, dflt = "''") => gen.valueToCode(b, name, order) || dflt;
const who = '(ev.author || ev.user || {})';

// one handler per hat block. A named hat (timer, web answer) only runs its blocks for that name.
function hatCode(event, named) {
  return (b) => {
    const body = gen.statementToCode(b, 'DO');
    const inner = named ? `  if (ev.name === ${q(b.getFieldValue('NAME'))}) {\n${gen.prefixLines(body, gen.INDENT)}  }\n` : body;
    return `bot.on('${event}', (ev) => {\n${inner}});\n\n`;
  };
}
const fb = gen.forBlock;
fb.bot_on_message = hatCode('message');
fb.bot_on_edit = hatCode('messageEdit');
fb.bot_on_join = hatCode('memberJoin');
fb.bot_on_leave = hatCode('memberLeave');
fb.bot_on_install = hatCode('install');
fb.bot_on_timer = hatCode('timer', true);
fb.bot_on_web = hatCode('fetch', true);

fb.bot_reply = (b) => `bot.reply(ev, ${V(b, 'TEXT')});\n`;
fb.bot_send = (b) => `{\n  const __ch = ev.channelId || (ev.channels && ev.channels[0] && ev.channels[0].id);\n  if (__ch) bot.send(__ch, ${V(b, 'TEXT')});\n}\n`;
fb.bot_react = (b) => `bot.react(ev, ${V(b, 'EMOJI')});\n`;
fb.bot_log = (b) => `bot.log(${V(b, 'VALUE', Order.NONE, 'null')});\n`;
fb.bot_text = () => ['ev.text', Order.MEMBER];
fb.bot_person = (b) => [`${who}.${b.getFieldValue('FIELD')}`, Order.MEMBER];
fb.bot_mention = () => [`('<@' + ${who}.id + '>')`, Order.ATOMIC];
fb.bot_mentions_me = () => ['(ev.mentionsBot === true)', Order.ATOMIC];
fb.bot_server_name = () => ["(ev.serverName || '')", Order.ATOMIC];

fb.bot_store_set = (b) => `bot.store.set(${V(b, 'KEY')}, ${V(b, 'VALUE', Order.NONE, 'null')});\n`;
fb.bot_store_add = (b) => `bot.store.incr(${V(b, 'KEY')}, ${V(b, 'BY', Order.NONE, '1')});\n`;
fb.bot_store_delete = (b) => `bot.store.delete(${V(b, 'KEY')});\n`;
fb.bot_store_get = (b) => [`bot.store.get(${V(b, 'KEY')})`, Order.FUNCTION_CALL];

fb.bot_timer_after = (b) => `bot.timer.after(${q(b.getFieldValue('NAME'))}, ${V(b, 'SECONDS', Order.NONE, '60')});\n`;
fb.bot_timer_every = (b) => `bot.timer.every(${q(b.getFieldValue('NAME'))}, ${V(b, 'SECONDS', Order.NONE, '3600')});\n`;
fb.bot_timer_daily = (b) => `bot.timer.daily(${q(b.getFieldValue('NAME'))}, ${q(b.getFieldValue('TIME'))}, ${q(b.getFieldValue('TZ') || 'UTC')});\n`;
fb.bot_timer_cancel = (b) => `bot.timer.cancel(${q(b.getFieldValue('NAME'))});\n`;

fb.bot_fetch = (b) => `bot.fetch(${V(b, 'URL')}, ${q(b.getFieldValue('NAME'))});\n`;
fb.bot_answer = (b) => [`ev.${b.getFieldValue('FIELD')}`, Order.MEMBER];
fb.bot_answer_value = (b) => [`(String(${V(b, 'KEY')}).split('.').reduce((o, k) => (o == null ? undefined : o[k]), ev.json))`, Order.ATOMIC];

fb.bot_text_starts = (b) => [`String(${V(b, 'A')}).startsWith(String(${V(b, 'B')}))`, Order.FUNCTION_CALL];
fb.bot_text_contains = (b) => [`String(${V(b, 'A')}).includes(String(${V(b, 'B')}))`, Order.FUNCTION_CALL];
fb.bot_word = (b) => [`(String(${V(b, 'TEXT')}).trim().split(/\\s+/)[${V(b, 'N', Order.SUBTRACTION, '1')} - 1] || '')`, Order.ATOMIC];
fb.bot_to_number = (b) => [`Number(${V(b, 'X')})`, Order.FUNCTION_CALL];
fb.bot_is_number = (b) => [`((x) => String(x).trim() !== '' && Number.isFinite(Number(x)))(${V(b, 'X')})`, Order.FUNCTION_CALL];

const HATS = new Set(['bot_on_message', 'bot_on_edit', 'bot_on_join', 'bot_on_leave', 'bot_on_install', 'bot_on_timer', 'bot_on_web']);

// Blocks -> JavaScript. Only blocks under an event block count (loose blocks are greyed out in the editor and left out here).
export function generate(ws) {
  gen.init(ws);
  let code = '';
  for (const b of ws.getTopBlocks(true)) if (HATS.has(b.type) && b.isEnabled()) code += gen.blockToCode(b);
  return gen.finish(code).trim();
}

// Same, from the saved layout, without a screen: used by the tests and by anything that has only the JSON.
export function codeFromLayout(json) {
  const ws = new Blockly.Workspace();
  try {
    Blockly.serialization.workspaces.load(typeof json === 'string' ? JSON.parse(json) : json, ws);
    return generate(ws);
  } finally { ws.dispose(); }
}

// ---------- the starting bot (the same one the JavaScript starter is) ----------
const t = (s) => ({ block: { type: 'text', fields: { TEXT: s } } });
const joinOf = (a, b) => ({ block: { type: 'text_join', extraState: { itemCount: 2 }, inputs: { ADD0: a, ADD1: b } } });
const START = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'bot_on_message', x: 24, y: 24,
        inputs: { DO: { block: { type: 'controls_if', inputs: {
          IF0: { block: { type: 'logic_compare', fields: { OP: 'EQ' }, inputs: { A: { block: { type: 'bot_text' } }, B: t('!ping') } } },
          DO0: { block: { type: 'bot_reply', inputs: { TEXT: joinOf(t('pong '), { block: { type: 'bot_mention' } }) } } },
        } } } },
      },
      {
        type: 'bot_on_join', x: 24, y: 250,
        inputs: { DO: { block: { type: 'bot_send', inputs: { TEXT: joinOf(t('Welcome '), { block: { type: 'bot_mention' } }) } } } },
      },
    ],
  },
};
export const startLayout = () => JSON.stringify(START);

// ---------- the editor ----------
const shadowText = (s) => ({ shadow: { type: 'text', fields: { TEXT: s } } });
const shadowNum = (n) => ({ shadow: { type: 'math_number', fields: { NUM: n } } });
const B = (type, extra = {}) => ({ kind: 'block', type, ...extra });
export const TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    { kind: 'category', name: 'Events', colour: COLORS.events, contents: ['bot_on_message', 'bot_on_edit', 'bot_on_join', 'bot_on_leave', 'bot_on_install', 'bot_on_timer', 'bot_on_web'].map((x) => B(x)) },
    { kind: 'category', name: 'Chat', colour: COLORS.chat, contents: [
      B('bot_reply', { inputs: { TEXT: shadowText('pong') } }),
      B('bot_send', { inputs: { TEXT: shadowText('Hello!') } }),
      B('bot_react', { inputs: { EMOJI: shadowText('\u{1F44D}') } }),
      B('bot_log', { inputs: { VALUE: shadowText('hello') } }),
      B('bot_text'), B('bot_person'), B('bot_mention'), B('bot_mentions_me'), B('bot_server_name'),
    ] },
    { kind: 'category', name: 'Saved data', colour: COLORS.data, contents: [
      B('bot_store_set', { inputs: { KEY: shadowText('name'), VALUE: shadowText('value') } }),
      B('bot_store_add', { inputs: { KEY: shadowText('count'), BY: shadowNum(1) } }),
      B('bot_store_delete', { inputs: { KEY: shadowText('name') } }),
      B('bot_store_get', { inputs: { KEY: shadowText('count') } }),
    ] },
    { kind: 'category', name: 'Timers', colour: COLORS.timers, contents: [
      B('bot_timer_after', { inputs: { SECONDS: shadowNum(60) } }),
      B('bot_timer_every', { inputs: { SECONDS: shadowNum(3600) } }),
      B('bot_timer_daily'), B('bot_timer_cancel'),
    ] },
    { kind: 'category', name: 'Web', colour: COLORS.web, contents: [
      B('bot_fetch', { inputs: { URL: shadowText('https://api.github.com/repos/owner/name') } }),
      B('bot_answer'),
      B('bot_answer_value', { inputs: { KEY: shadowText('stargazers_count') } }),
    ] },
    { kind: 'sep' },
    { kind: 'category', name: 'Control', colour: COLORS.control, contents: [
      B('controls_if'), B('controls_if', { extraState: { hasElse: true } }),
      B('controls_repeat_ext', { inputs: { TIMES: shadowNum(3) } }),
      B('controls_whileUntil'), B('controls_forEach'),
    ] },
    { kind: 'category', name: 'Operators', colour: COLORS.ops, contents: [
      B('logic_compare'), B('logic_operation'), B('logic_negate'), B('logic_boolean'),
      B('math_number'), B('math_arithmetic', { inputs: { A: shadowNum(1), B: shadowNum(1) } }),
      B('math_random_int', { inputs: { FROM: shadowNum(1), TO: shadowNum(6) } }),
      B('math_modulo', { inputs: { DIVIDEND: shadowNum(10), DIVISOR: shadowNum(3) } }),
      B('math_round', { inputs: { NUM: shadowNum(3.1) } }),
      B('text'), B('text_join'), B('text_length', { inputs: { VALUE: shadowText('abc') } }),
      B('text_changeCase', { inputs: { TEXT: shadowText('abc') } }), B('text_trim', { inputs: { TEXT: shadowText(' abc ') } }),
      B('bot_text_starts', { inputs: { B: shadowText('!') } }), B('bot_text_contains', { inputs: { B: shadowText('hello') } }),
      B('bot_word', { inputs: { N: shadowNum(2) } }), B('bot_to_number'), B('bot_is_number'),
    ] },
    { kind: 'category', name: 'Lists', colour: COLORS.lists, contents: [
      B('lists_create_with', { extraState: { itemCount: 3 } }), B('lists_length'), B('lists_getIndex'),
      B('lists_split', { inputs: { DELIM: shadowText(' ') } }),
    ] },
    { kind: 'category', name: 'Variables', colour: COLORS.vars, custom: 'VARIABLE' },
  ],
};

const css = (name, dflt) => {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || dflt; } catch { return dflt; }
};
function makeTheme() {
  const style = (c, extra = {}) => ({ colourPrimary: c, ...extra });
  return Blockly.Theme.defineTheme('aduna', {
    name: 'aduna',
    base: Blockly.Themes.Classic,
    blockStyles: {
      event_blocks: style(COLORS.events, { hat: 'cap' }),
      logic_blocks: style(COLORS.control), loop_blocks: style(COLORS.control),
      math_blocks: style(COLORS.ops), text_blocks: style(COLORS.ops),
      list_blocks: style(COLORS.lists),
      variable_blocks: style(COLORS.vars), variable_dynamic_blocks: style(COLORS.vars),
    },
    componentStyles: {
      workspaceBackgroundColour: 'transparent',
      toolboxBackgroundColour: css('--raised', '#fffdf8'),
      toolboxForegroundColour: css('--head', '#14110d'),
      flyoutBackgroundColour: css('--field', '#f0eadb'),
      flyoutForegroundColour: css('--head', '#14110d'),
      flyoutOpacity: 1,
      scrollbarColour: '#9a9080',
      scrollbarOpacity: 0.5,
    },
    fontStyle: { family: 'inherit', weight: '600', size: 11 },
    startHats: true,
  });
}

// Aduna's Content-Security-Policy (style-src 'self', see server/security.js) refuses the <style> elements Blockly adds to the page for its own
// look, so without this the editor would load but be unstyled. The text of a refused element can still be read: copy each one into a constructed
// stylesheet (set through the CSSOM, which the policy does not restrict) and remove the element. A page without the policy (the dev server)
// gets the same result. A browser without constructed stylesheets keeps Blockly's own elements, which is right when nothing blocks them.
const blocklySheets = new Map(); // style element id -> the sheet that replaced it
function adoptBlocklyStyles() {
  if (typeof document === 'undefined' || !('adoptedStyleSheets' in document) || typeof CSSStyleSheet !== 'function') return;
  for (const el of Array.from(document.querySelectorAll('style[id^="blockly"]'))) {
    try {
      let sheet = blocklySheets.get(el.id);
      if (!sheet) {
        sheet = new CSSStyleSheet();
        blocklySheets.set(el.id, sheet);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      sheet.replaceSync(el.textContent || ''); // the newest text wins if Blockly adds the same element again
      el.remove();
    } catch { /* leave the element where it is */ }
  }
}
let watchingStyles = false;
function watchBlocklyStyles() {
  adoptBlocklyStyles();
  if (watchingStyles || typeof MutationObserver !== 'function') return;
  watchingStyles = true;
  new MutationObserver(adoptBlocklyStyles).observe(document.head, { childList: true });
}

// Puts the editor in `container`. `initial` is a saved layout (JSON text) or null for the starting bot. onChange({ layout, code, user }) fires
// after loading (user: false) and after every edit (user: true, a little delayed so dragging stays smooth).
export function injectEditor(container, { initial, onChange, readOnly = false } = {}) {
  const narrow = window.innerWidth < 640;
  watchBlocklyStyles();
  const ws = Blockly.inject(container, {
    toolbox: TOOLBOX, theme: makeTheme(), renderer: 'zelos', readOnly, sounds: false,
    horizontalLayout: narrow, toolboxPosition: narrow ? 'end' : 'start',
    zoom: { controls: true, wheel: false, startScale: narrow ? 0.8 : 0.95, maxScale: 2, minScale: 0.4, scaleSpeed: 1.2 },
    // the mouse wheel keeps scrolling the page (this editor sits inside a long settings page); drag the background to move around
    move: { scrollbars: true, drag: true, wheel: false },
    grid: { spacing: 24, length: 2, colour: '#8a806c33', snap: false },
    trashcan: !readOnly,
  });
  adoptBlocklyStyles();
  let failed = null;
  try { Blockly.serialization.workspaces.load(JSON.parse(initial || startLayout()), ws); }
  catch (e) { failed = e; ws.clear(); Blockly.serialization.workspaces.load(START, ws); }
  ws.addChangeListener(Blockly.Events.disableOrphans); // a loose block is greyed out, like Scratch: it never runs

  const snapshot = (user) => ({ layout: JSON.stringify(Blockly.serialization.workspaces.save(ws)), code: generate(ws), user });
  let timer = null, dead = false;
  const listener = (e) => {
    if (e.isUiEvent || e.type === Blockly.Events.FINISHED_LOADING || readOnly) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!dead) onChange?.(snapshot(true)); }, 200);
  };
  ws.addChangeListener(listener);
  onChange?.({ ...snapshot(false), reset: !!failed });

  const resize = () => Blockly.svgResize(ws);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  ro?.observe(container);
  return {
    ws, resize,
    // replace everything on the screen (used when the bot is reset to the starting blocks)
    load(json) { ws.clear(); Blockly.serialization.workspaces.load(JSON.parse(json || startLayout()), ws); onChange?.(snapshot(false)); },
    dispose() { dead = true; clearTimeout(timer); ro?.disconnect(); ws.dispose(); },
  };
}
