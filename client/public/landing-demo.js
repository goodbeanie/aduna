// The hero chat answers back. Maya, Tristan and Beanie ask for a name, then talk: an @mention lights up, "dark mode" really changes this page,
// a question about privacy points at the section below. It is a scripted demo and says so ("live demo" in the title bar).
//
// Once someone has given a name, every "Join Aduna" button becomes "Join as <name>", and the name and avatar colour are put in the sign-up
// draft (sessionStorage 'aduna-signup-draft', the one SignupFlow.jsx reads), so step 1 of sign-up opens already started.
// Nothing is sent anywhere, and nothing is stored until a name has been typed. People who are signed in never see the form.
// Everything the visitor types is added with textContent, never as HTML.
(function () {
  var mock = document.getElementById('demo'), log = document.getElementById('demo-log'),
    form = document.getElementById('demo-form'), input = document.getElementById('demo-input'),
    label = document.getElementById('demo-label');
  if (!mock || !log || !form || !input || !label) return;
  try { if (localStorage.getItem('aduna_in') || localStorage.getItem('aduna_token')) return; } catch (e) { /* storage blocked: treat as signed out */ }

  var DRAFT = 'aduna-signup-draft';
  // the sign-up's avatar colours (HUES in SignupFlow.jsx); its seventh, near-black, is left out because it would vanish on the dark chat
  var HUES = ['#8c6b4f', '#b4553d', '#5f7a55', '#a67c1f', '#4b6a88', '#7a5a7d'];
  var BOTS = { maya: ['is1', 'is2', 'M'], tristan: ['is3', 'is4', 'T'], beanie: ['is5', 'is6', 'B'] }; // avatar class, name class, letter (classes live in landing.css)
  var NAMES = ['maya', 'tristan', 'beanie'];
  var DARK = ['midnight', 'ember', 'plum', 'evergreen', 'charcoal', 'zen'];
  var LIGHT = ['ocean', 'forest', 'rose', 'lavender', 'sunset', 'zen-light', 'parchment'];
  var CAP = 10; // messages a visitor can send before the demo says goodbye

  var me = { name: '', color: HUES[Math.floor(Math.random() * HUES.length)] };
  var stage = 'name'; // name -> chat
  var sent = 0, clock = 44, count = 0, last = 'beanie', invited = false;
  var queue = [], playing = false;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function chars(s) { return Array.from(s); }
  function short(n) { var c = chars(n); return c.length > 14 ? c.slice(0, 13).join('') + '\u2026' : n; } // keeps "Join as ..." on one line on a phone
  function stamp() { return '8:' + (clock < 10 ? '0' : '') + clock + ' PM'; } // the demo's own clock: a minute passes every other message
  function toEnd() { log.scrollTop = log.scrollHeight; }

  // Bot text: {@} is a ping for the visitor. Visitor text: @maya, @tristan and @beanie light up the same way.
  function fillBot(node, text) {
    text.split('{@}').forEach(function (part, i) {
      if (i) node.appendChild(el('span', 'mn', '@' + me.name));
      if (part) node.appendChild(document.createTextNode(part));
    });
  }
  function fillYou(node, text) {
    text.split(/(@(?:maya|tristan|beanie)\b)/i).forEach(function (part) {
      if (!part) return;
      node.appendChild(/^@/.test(part) ? el('span', 'mn', part) : document.createTextNode(part));
    });
  }

  function addMsg(who, text, withJoin) {
    var you = who === 'you', b = BOTS[who];
    var row = el('div', 'm new');
    var av = el('div', 'av ' + (you ? 'you' : b[0]), you ? chars(me.name)[0].toUpperCase() : b[2]);
    if (you) av.style.background = me.color; // set through the style object, which the page's CSP allows (an inline style="" attribute it does not)
    var body = el('div'), n = el('div', 'n ' + (you ? 'you' : b[1]));
    n.appendChild(document.createTextNode(you ? me.name : who));
    n.appendChild(el('small', null, stamp()));
    var t = el('div', 't');
    (you ? fillYou : fillBot)(t, text);
    if (withJoin) {
      var a = el('a', 'btn sm join-inline', 'Join as ' + short(me.name));
      a.href = '/app#signup';
      var wrap = el('div'); wrap.appendChild(a); t.appendChild(wrap);
    }
    body.appendChild(n); body.appendChild(t);
    row.appendChild(av); row.appendChild(body);
    log.appendChild(row);
    count++; if (count % 2 === 0) clock++;
    if (!you) last = who;
    toEnd();
  }

  function typing(who) {
    var t = el('div', 'typing'); t.setAttribute('aria-hidden', 'true');
    t.appendChild(el('i')); t.appendChild(el('i')); t.appendChild(el('i'));
    t.appendChild(el('span', null, who + ' is typing'));
    log.appendChild(t); toEnd();
    return t;
  }

  // Replies go out one at a time, each after a "... is typing" moment, so two quick messages from the visitor still get an orderly answer.
  function say(who, text, opts) { queue.push({ who: who, text: text, o: opts || {} }); if (!playing) next(); }
  function next() {
    var job = queue.shift();
    if (!job) { playing = false; return; }
    playing = true;
    var t = typing(job.who);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
      addMsg(job.who, job.text, job.o.join);
      if (job.o.then) job.o.then();
      setTimeout(next, 350);
    }, Math.min(1700, 500 + job.text.length * 24));
  }

  // ---- what the visitor's name turns into on this page and in sign-up ----
  function relabel() {
    var txt = 'Join as ' + short(me.name);
    document.querySelectorAll('a.go.primary').forEach(function (a) { a.textContent = txt; });
  }
  function save() {
    try {
      var d = JSON.parse(sessionStorage.getItem(DRAFT) || 'null');
      if (!d || typeof d !== 'object') d = {};
      d.displayName = me.name; d.avatarColor = me.color;
      sessionStorage.setItem(DRAFT, JSON.stringify(d));
    } catch (e) { /* private mode: the buttons still use the name, sign-up just starts blank */ }
  }

  function cleanName(v) {
    return v.replace(/^(?:hi|hey|hello|yo)[,!.\s]+/i, '')
      .replace(/^(?:i['\u2019]?m|i am|my name is|my name['\u2019]?s|it['\u2019]?s|call me|this is)\s+/i, '')
      .replace(/[.!,;:]+$/g, '').trim();
  }
  function takeName(v) {
    var s = cleanName(v), words = s ? s.split(/\s+/) : [];
    if (!s || words.length > 2) { // a sentence, not a name: ask again and leave their text in the box to edit
      say('beanie', s ? "ha, that's a lot of name. a first name or a nickname is plenty" : 'a first name or a nickname is plenty');
      return;
    }
    me.name = chars(s).slice(0, 20).join('');
    stage = 'chat';
    input.value = '';
    input.placeholder = 'Say something to the group';
    label.textContent = 'Type a message to the demo chat';
    addMsg('you', "hi, I'm " + me.name);
    say('maya', pick(['hiii {@}!! welcome in', 'hey {@}, so glad you stopped by']));
    say('tristan', pick(['pull up a chair, we were about to start', 'you picked a good night to show up']));
    relabel(); save();
  }

  // ---- small talk ----
  var FALL = ['ha, same', 'okay yes', 'wait, say more', 'love that', 'noted. writing it on the wall', 'honestly this is why i like this place', 'you fit in here already'];
  var ASK = ["good question. i'm a demo, so my answers run out. the real chat doesn't", "hm. ask me again once you've joined, i have a lot more to say there"];
  var RULES = [
    { re: /^(hi+|hey+|hello|yo|hiya|howdy|sup)(\s+@?\w+)?\W*$/, run: function () { return [['maya', pick(['hey {@}!', 'hi hi {@}'])]]; } }, // a bare greeting only, so "hey, dark mode?" is not answered with a wave
    { re: /\b(themes?|colou?rs?|dark|light|restyle|aesthetic)\b/, run: function (s) {
      var pool = /dark/.test(s) ? DARK : /light/.test(s) ? LIGHT : DARK.concat(LIGHT);
      var on = document.querySelector('.sw[aria-pressed="true"]'), cur = on && on.getAttribute('data-theme');
      var id = pick(pool.filter(function (x) { return x !== cur; }));
      return [
        ['beanie', 'oh, you want a new look? watch the whole page.', { then: function () { document.dispatchEvent(new CustomEvent('aduna:try-theme', { detail: id })); } }],
        ['maya', pick(['okay, that one is nice. the dots under the headline do the same, and your pick carries into sign-up', 'ooh. once you are in, you can even make your own from two colours'])]
      ];
    } },
    { re: /\b(privacy|private|encrypt\w*|secret|secure|safe|dms?|spy|spying)\b/, run: function () {
      return [['maya', 'DMs are encrypted in your browser before they leave it, so the server only ever holds scrambled text. there is a whole section about it further down']];
    } },
    { re: /\b(voice|calls?|video|camera|screen ?share|vc|stream)\b/, run: function () {
      return [['tristan', pick(['there is a voice channel called chill, open all night. calls have camera and screen share too', 'one-to-one calls with camera and screen share, or a voice channel for the whole group'])]];
    } },
    { re: /\b(games?|play|playing|trivia|gaming)\b/, run: function () {
      return [['tristan', 'trivia is happening, i have been told'], ['beanie', "i'm not saying i've been studying, but i'm not saying i haven't"]];
    } },
    { re: /\b(join|sign ?up|account|free|cost|price|download|install|app)\b/, run: function () {
      invited = true;
      return [['beanie', 'it takes about a minute. you pick a name, a picture and a look first, and email and password come after', { join: true }]];
    } },
    { re: /\b(thanks|thank you|thx|ty)\b/, run: function () { return [['maya', 'anytime \uD83D\uDC9B']]; } },
    { re: /\b(lol|lmao|haha+|hehe+)\b|\uD83D\uDE02|\uD83E\uDD23/, run: function () { return [['tristan', pick(['\uD83D\uDE02', 'okay, that got me', 'lol same'])]]; } },
    { re: /\b(bots?|ai|real|fake|robots?|human|scripted)\b/, run: function () { return [['maya', "ha, fair. we're a demo, so yes, a little scripted. the people you invite are very real"]]; } }
  ];

  function respond(v) {
    var s = v.toLowerCase(), who = (s.match(/@(maya|tristan|beanie)\b/) || [])[1], out = null;
    for (var i = 0; i < RULES.length; i++) { if (RULES[i].re.test(s)) { out = RULES[i].run(s); break; } }
    if (!out) {
      var other = pick(NAMES.filter(function (x) { return x !== last; }));
      out = /\?\s*$/.test(v) ? [[who || 'beanie', pick(ASK)]] : [[who || other, pick(FALL)]];
    } else if (who) out[0][0] = who; // asking someone by name gets that someone
    return out;
  }

  function invite() {
    if (invited) return;
    invited = true;
    say('beanie', "okay {@}, you're basically one of us. want a permanent spot?", { join: true });
  }

  function chat(v) {
    addMsg('you', v);
    sent++;
    respond(v).forEach(function (x) { say(x[0], x[1], x[2]); });
    if (sent === 3) invite();
    if (sent >= CAP) {
      input.disabled = true; form.querySelector('button').disabled = true;
      input.placeholder = 'Join Aduna to keep chatting';
      say('maya', "we're out of material, {@}! the real thing doesn't run out", { join: true });
    }
  }

  // ---- go ----
  mock.classList.add('live');
  input.placeholder = 'Type your name here';
  label.textContent = 'Your name for the demo chat';
  form.classList.add('nudge'); // a gentle pulse on the box until they touch it
  function calm() { form.classList.remove('nudge'); }
  input.addEventListener('focus', calm, { once: true });
  input.addEventListener('input', calm, { once: true });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = input.value.replace(/\s+/g, ' ').trim();
    if (!v || input.disabled) return;
    if (stage === 'name') { takeName(v); return; }
    input.value = '';
    chat(v);
  });
  setTimeout(function () { if (stage === 'name') say('beanie', 'wait, new face! what should we call you?'); }, 1400);
})();
