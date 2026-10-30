import React, { useState, useEffect } from 'react';
import { api } from './api.js';
import { rewrapIdentity, makeRecoveryFromPassword, sealIdentityForDevice } from './crypto.js';
import { passkeysSupported, addPasskey, removePasskey, thisDeviceName } from './passkeys.js';
import { RecoveryKeyCard } from './Recovery.jsx';
import * as notify from './notify.js';

// Settings > Security: change the password, recovery key, email recovery, two-factor login, passkeys, approving a sign-in on another
// device, and sign out of every device at once.

// After the server dropped this device's push registration (it does that whenever it revokes sessions), put it back.
async function resubscribe() {
  if (notify.permission() === 'granted') await Promise.race([notify.subscribe().catch(() => {}), new Promise((res) => setTimeout(res, 12000))]);
}

function Section({ title, children }) {
  return <section className="sec-section"><h2>{title}</h2>{children}</section>;
}

// The password also wraps the end-to-end encryption key. The browser unwraps it with the old password, wraps it with the new one and
// sends only the new ciphertext, so DMs keep working. Every other device is signed out; this one carries on.
function ChangePassword({ me, getSocketId }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [fe, setFe] = useState(null); // { f, m }: a problem with one field, shown under it
  const bad = (f, m) => { setFe({ f, m }); setMsg(''); setTimeout(() => document.getElementById('sec-' + f)?.focus(), 0); };
  const fp = (f) => ({ id: 'sec-' + f, 'aria-invalid': fe?.f === f ? true : undefined, 'aria-describedby': fe?.f === f ? 'sec-e-' + f : undefined });
  const ferr = (f) => (fe?.f === f ? <p className="error-text field-error" id={'sec-e-' + f} role="alert">{fe.m}</p> : null);
  const edit = (f, set) => (e) => { set(e.target.value); if (fe?.f === f) setFe(null); };

  const run = async () => {
    if (busy) return;
    if (next.length < 8) return bad('next', 'The new password must be at least 8 characters.');
    if (next !== again) return bad('again', 'The two new passwords do not match.');
    if (next === cur) return bad('next', 'Choose a different password from the current one.');
    setBusy(true); setMsg(''); setFe(null);
    try {
      const { encPrivKey } = await api('/me');
      let blob;
      if (encPrivKey) {
        try { blob = await rewrapIdentity(encPrivKey, cur, next); } catch { setBusy(false); return bad('cur', 'That current password is not right.'); }
      }
      await api('/me/password', { method: 'POST', body: { currentPassword: cur, newPassword: next, encPrivKey: blob, code: me.twoFactor ? code : undefined, socketId: getSocketId?.() || '' } });
      await resubscribe();
      location.reload();
    } catch (e) {
      setMsg(e.message || 'Could not change the password. Try again.');
      setBusy(false);
    }
  };

  return (
    <Section title="Change password">
      <p className="muted">Your password also protects your encryption key. It is re-locked here in your browser, so your messages stay readable. Every other device is signed out.</p>
      <label htmlFor="sec-cur">CURRENT PASSWORD</label>
      <input {...fp('cur')} type="password" value={cur} autoComplete="current-password" disabled={busy} onChange={edit('cur', setCur)} />
      {ferr('cur')}
      <label htmlFor="sec-next">NEW PASSWORD</label>
      <input {...fp('next')} type="password" value={next} autoComplete="new-password" disabled={busy} onChange={edit('next', setNext)} />
      {ferr('next')}
      <label htmlFor="sec-again">NEW PASSWORD AGAIN</label>
      <input {...fp('again')} type="password" value={again} autoComplete="new-password" disabled={busy} onChange={edit('again', setAgain)} />
      {ferr('again')}
      {me.twoFactor && <>
        <label>AUTHENTICATOR CODE</label>
        <input value={code} autoComplete="one-time-code" maxLength={20} disabled={busy} placeholder="123456" onChange={(e) => setCode(e.target.value)} />
      </>}
      <p className="hint">If you forget it you can reset it with your recovery key (see below), so make sure you have one.</p>
      <div className="notify-actions">
        <button className="btn primary" disabled={busy || !cur || !next || !again || (me.twoFactor && !code)} onClick={run}>{busy ? 'Changing…' : 'Change password'}</button>
      </div>
      {msg && <p className="error-text small" role="alert">{msg}</p>}
    </Section>
  );
}

// The recovery key is the way back in after a forgotten password: it opens a second copy of the encryption key that only it can unlock.
// Made here in the browser (the password unlocks the key first), shown once, and never sent to us. Making a new one replaces the old one.
function RecoveryKey({ me, onSaved }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [badPw, setBadPw] = useState(false); // the password was wrong: say so under the field
  const [made, setMade] = useState(null); // the key, while it is on screen

  const run = async () => {
    if (busy) return;
    setBusy(true); setMsg(''); setBadPw(false);
    try {
      const { encPrivKey } = await api('/me');
      if (!encPrivKey) throw new Error('This account has no encryption key yet. Log out and back in once, then try again.');
      let rec;
      try { rec = await makeRecoveryFromPassword(encPrivKey, password); } catch { setBadPw(true); setBusy(false); setTimeout(() => document.getElementById('sec-rk-pw')?.focus(), 0); return; }
      const r = await api('/me/recovery', { method: 'PUT', body: { password, code: me.twoFactor ? code : undefined, recovery: { blob: rec.blob, auth: rec.auth } } });
      setMade(rec.key); setPassword(''); setCode('');
      onSaved?.(r.user);
    } catch (e) {
      setMsg(e.message || 'Could not create the recovery key. Try again.');
    }
    setBusy(false);
  };

  if (made) return (
    <Section title="Recovery key">
      <RecoveryKeyCard recoveryKey={made} username={me.username} title="Your new recovery key" doneLabel="Done" onDone={() => setMade(null)} />
    </Section>
  );

  return (
    <Section title="Recovery key">
      {me.recoveryKey
        ? <p className="muted">You have a recovery key. If you forget your password, use <strong>Forgot your password?</strong> on the login screen with it. Making a new key replaces the old one, which then stops working.</p>
        : <p className="muted"><strong>You do not have one yet.</strong> Without a recovery key, a forgotten password means losing the account, because your password also locks your encryption key. Make one now and keep it somewhere safe.</p>}
      <label htmlFor="sec-rk-pw">YOUR PASSWORD</label>
      <input id="sec-rk-pw" aria-invalid={badPw || undefined} aria-describedby={badPw ? 'sec-e-rk-pw' : undefined} type="password" value={password} autoComplete="current-password" disabled={busy} onChange={(e) => { setPassword(e.target.value); setBadPw(false); }} />
      {badPw && <p className="error-text field-error" id="sec-e-rk-pw" role="alert">That password is not right.</p>}
      {me.twoFactor && <>
        <label>AUTHENTICATOR CODE</label>
        <input value={code} autoComplete="one-time-code" maxLength={20} disabled={busy} placeholder="123456" onChange={(e) => setCode(e.target.value)} />
      </>}
      <div className="notify-actions">
        <button className="btn primary" disabled={busy || !password || (me.twoFactor && !code)} onClick={run}>{busy ? 'Working…' : me.recoveryKey ? 'Make a new recovery key' : 'Make a recovery key'}</button>
      </div>
      {msg && <p className="error-text small" role="alert">{msg}</p>}
    </Section>
  );
}

// Email recovery (optional): a code sent to your verified address can reset a forgotten password if you also lost your recovery key.
// Because the encryption key never leaves your devices, an email cannot bring it back: that reset makes a NEW key and older DMs become unreadable.
function EmailRecovery({ me, onSaved }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false); // msg is a confirmation, not a problem
  const on = !!me.emailRecovery;

  const run = async () => {
    if (busy) return;
    setBusy(true); setMsg(''); setOk(false);
    try {
      const r = await api('/me/email-recovery', { method: 'PUT', body: { enabled: !on, password, code: me.twoFactor ? code : undefined } });
      setPassword(''); setCode('');
      onSaved?.(r.user);
      setMsg(on ? 'Email recovery is off.' : 'Email recovery is on.'); setOk(true);
    } catch (e) { setMsg(e.message || 'Could not change that. Try again.'); }
    setBusy(false);
  };

  return (
    <Section title="Email recovery">
      <p className="muted">
        Email recovery is <strong>{on ? 'on' : 'off'}</strong>.{' '}
        {on ? <>If you forget your password and have lost your recovery key, we can email a reset link to <strong>{me.email}</strong> to reset it.</>
            : <>Off by default. Turn it on to be able to reset a forgotten password with a code sent to your email, even without a recovery key.</>}
      </p>
      <p className="hint">The catch: your encryption key only exists on your devices, so an email reset creates a <strong>new</strong> key and your older direct messages become unreadable. The recovery key above avoids that. Anyone who controls your mailbox could use email recovery, so keep this off if you do not trust it.</p>
      {!me.emailRecoveryAvailable && !on
        ? <p className="muted small">{me.email ? 'Verify your email address first (and the server must have email set up).' : 'Add and verify an email address first.'}</p>
        : <>
            <label>YOUR PASSWORD</label>
            <input type="password" value={password} autoComplete="current-password" disabled={busy} onChange={(e) => setPassword(e.target.value)} />
            {me.twoFactor && <>
              <label>AUTHENTICATOR CODE</label>
              <input value={code} autoComplete="one-time-code" maxLength={20} disabled={busy} placeholder="123456" onChange={(e) => setCode(e.target.value)} />
            </>}
            <div className="notify-actions">
              <button className={'btn ' + (on ? 'danger' : 'primary')} disabled={busy || !password || (me.twoFactor && !code)} onClick={run}>{busy ? 'Working…' : on ? 'Turn off email recovery' : 'Turn on email recovery'}</button>
            </div>
          </>}
      {msg && <p className={(ok ? 'ok-text' : 'error-text') + ' small'} role="alert">{msg}</p>}
    </Section>
  );
}

// An authenticator app (Google Authenticator, Authy, 1Password, …) gives a 6-digit code that changes every 30 seconds.
function TwoFactor({ me, onSaved }) {
  const [stage, setStage] = useState('idle'); // idle | setup | codes
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState(null);   // { secret, uri }
  const [codes, setCodes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refresh = async () => { try { const r = await api('/me'); onSaved?.(r.user); } catch { /* the page will catch up on its next load */ } };
  const guard = async (fn) => { setBusy(true); setMsg(''); try { await fn(); } catch (e) { setMsg(e.message || 'Something went wrong. Try again.'); } setBusy(false); };

  const start = () => guard(async () => {
    setSetup(await api('/me/2fa/setup', { method: 'POST', body: { password } }));
    setPassword(''); setCode(''); setStage('setup');
  });
  const enable = () => guard(async () => {
    const r = await api('/me/2fa/enable', { method: 'POST', body: { code } });
    setCodes(r.recoveryCodes); setSetup(null); setCode(''); setStage('codes');
  });
  const disable = () => guard(async () => {
    await api('/me/2fa/disable', { method: 'POST', body: { password, code } });
    setPassword(''); setCode(''); await refresh();
  });
  const done = async () => { setCodes([]); setStage('idle'); await refresh(); };
  const copy = () => navigator.clipboard?.writeText(codes.join('\n')).then(() => setMsg('Copied.')).catch(() => setMsg('Could not copy. Write them down instead.'));
  const group = (s) => s.replace(/(.{4})/g, '$1 ').trim();

  if (stage === 'codes') return (
    <Section title="Two-factor login">
      <p><strong>Two-factor is on.</strong> Save these recovery codes now. Each one works once if you lose your phone, and they are not shown again.</p>
      <div className="recovery-codes">{codes.map((c) => <code key={c}>{c}</code>)}</div>
      <div className="notify-actions">
        <button className="btn" onClick={copy}>Copy codes</button>
        <button className="btn primary" onClick={done}>I saved them</button>
      </div>
      {msg && <p className={(msg === 'Copied.' ? 'ok-text' : 'error-text') + ' small'} role="alert">{msg}</p>}
    </Section>
  );

  if (stage === 'setup' && setup) return (
    <Section title="Two-factor login">
      <p className="muted">1. Add this account to your authenticator app. On a phone, tap the link; otherwise choose “enter a setup key” and type the key.</p>
      <div className="recovery-codes"><code>{group(setup.secret)}</code></div>
      <p className="small"><a href={setup.uri}>Open in my authenticator app</a></p>
      <p className="muted">2. Enter the 6-digit code it shows to turn two-factor on.</p>
      <input value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={8} disabled={busy} placeholder="123456" autoFocus
        onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code && enable()} />
      <div className="notify-actions">
        <button className="btn primary" disabled={busy || !code} onClick={enable}>{busy ? 'Checking…' : 'Turn on'}</button>
        <button className="btn" disabled={busy} onClick={() => { setStage('idle'); setSetup(null); setMsg(''); }}>Cancel</button>
      </div>
      {msg && <p className="error-text small" role="alert">{msg}</p>}
    </Section>
  );

  return (
    <Section title="Two-factor login">
      {me.twoFactor ? (
        <>
          <p className="muted">Two-factor is <strong>on</strong>: logging in needs your password and a code from your authenticator app. To turn it off, enter your password and a current code (or a recovery code).</p>
          <label>YOUR PASSWORD</label>
          <input type="password" value={password} autoComplete="current-password" disabled={busy} onChange={(e) => setPassword(e.target.value)} />
          <label>AUTHENTICATOR CODE</label>
          <input value={code} autoComplete="one-time-code" maxLength={20} disabled={busy} placeholder="123456" onChange={(e) => setCode(e.target.value)} />
          <div className="notify-actions">
            <button className="btn danger" disabled={busy || !password || !code} onClick={disable}>{busy ? 'Working…' : 'Turn off two-factor'}</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Add a second step to logging in. Even if someone learns your password they cannot get in without the code from your phone.</p>
          <label>YOUR PASSWORD</label>
          <input type="password" value={password} autoComplete="current-password" disabled={busy} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && password && start()} />
          <div className="notify-actions">
            <button className="btn primary" disabled={busy || !password} onClick={start}>{busy ? 'Working…' : 'Set up two-factor'}</button>
          </div>
        </>
      )}
      {msg && <p className="error-text small" role="alert">{msg}</p>}
    </Section>
  );
}

// Passkeys: log in with a fingerprint, face or device PIN instead of the password. Each one also unlocks the encryption key (passkeys.js),
// so adding or removing one asks for the password (and the two-factor code) again.
function Passkeys({ me, onSaved }) {
  const supported = passkeysSupported();
  const [list, setList] = useState(null); // null while loading
  const [name, setName] = useState(() => thisDeviceName());
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const [badPw, setBadPw] = useState(false);

  useEffect(() => {
    let stop = false;
    api('/me/passkeys').then((r) => { if (!stop) setList(r.passkeys || []); }).catch(() => { if (!stop) setList([]); });
    return () => { stop = true; };
  }, []);

  const after = (r, text) => {
    setList(r.passkeys || []); setPassword(''); setCode(''); setBadPw(false);
    if (r.user) onSaved?.(r.user);
    setMsg(text); setOk(true);
  };
  const fail = (e) => {
    if (e.field === 'password') { setBadPw(true); setMsg(''); setTimeout(() => document.getElementById('sec-pk-pw')?.focus(), 0); }
    else { setMsg(e.message || 'Something went wrong. Try again.'); }
    setOk(false);
  };

  const add = async () => {
    if (busy) return;
    setBusy(true); setMsg(''); setOk(false); setBadPw(false);
    try { after(await addPasskey({ password, code: me.twoFactor ? code : undefined, name: name.trim() || thisDeviceName() }), 'Passkey added. You can now log in with it.'); }
    catch (e) { fail(e); }
    setBusy(false);
  };
  const remove = async (p) => {
    if (busy || !password) return;
    setBusy(true); setMsg(''); setOk(false); setBadPw(false);
    try { after(await removePasskey({ id: p.id, password, code: me.twoFactor ? code : undefined }), 'Passkey removed.'); }
    catch (e) { fail(e); }
    setBusy(false);
  };

  const when = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const needCode = me.twoFactor && !code;

  return (
    <Section title="Passkeys">
      <p className="muted">Log in with your fingerprint, face or device PIN instead of typing a password. A passkey also opens your encryption key, so your messages stay readable. You can have up to 10.</p>
      {list && list.length > 0 && (
        <ul className="pk-list">
          {list.map((p) => (
            <li key={p.id}>
              <div>
                <strong>{p.name}</strong>
                <span className="muted small">Added {when(p.createdAt)}{p.lastUsedAt ? ` · last used ${when(p.lastUsedAt)}` : ' · never used'}</span>
              </div>
              <button className="btn danger" disabled={busy || !password || needCode} onClick={() => remove(p)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {list && list.length === 0 && <p className="hint">You have no passkeys yet.</p>}
      {!supported && <p className="muted small">This browser or address cannot make passkeys. Open Aduna in a recent browser over HTTPS to add one.</p>}
      <label htmlFor="sec-pk-name">NAME FOR THIS PASSKEY</label>
      <input id="sec-pk-name" value={name} maxLength={40} disabled={busy || !supported} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="sec-pk-pw">YOUR PASSWORD</label>
      <input id="sec-pk-pw" aria-invalid={badPw || undefined} aria-describedby={badPw ? 'sec-e-pk-pw' : undefined} type="password" value={password} autoComplete="current-password" disabled={busy}
        onChange={(e) => { setPassword(e.target.value); setBadPw(false); }} />
      {badPw && <p className="error-text field-error" id="sec-e-pk-pw" role="alert">That password is not right.</p>}
      {me.twoFactor && <>
        <label>AUTHENTICATOR CODE</label>
        <input value={code} autoComplete="one-time-code" maxLength={20} disabled={busy} placeholder="123456" onChange={(e) => setCode(e.target.value)} />
      </>}
      <p className="hint">The password is asked again to add or remove a passkey, because a passkey is a way into your account and your messages.</p>
      <div className="notify-actions">
        <button className="btn primary" disabled={busy || !supported || !password || needCode || (list && list.length >= 10)} onClick={add}>{busy ? 'Working…' : 'Add a passkey'}</button>
      </div>
      {msg && <p className={(ok ? 'ok-text' : 'error-text') + ' small'} role="alert">{msg}</p>}
    </Section>
  );
}

// The signed-in side of "Log in with another device" (DeviceLogin.jsx): type the code the new device shows, check what is asking, and
// confirm with the password. The browser opens the encryption key and locks it to the new device's throwaway key (crypto.js).
function ApproveSignIn({ me }) {
  const [stage, setStage] = useState('code'); // code | confirm | done
  const [request, setRequest] = useState('');
  const [found, setFound] = useState(null); // { device, minutesAgo, sameNetwork, publicKey }
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [badPw, setBadPw] = useState(false);

  const reset = () => { setStage('code'); setRequest(''); setFound(null); setPassword(''); setCode(''); setMsg(''); setBadPw(false); };
  const guard = async (fn) => { setBusy(true); setMsg(''); try { await fn(); } catch (e) { setMsg(e.message || 'Something went wrong. Try again.'); } setBusy(false); };

  const look = () => guard(async () => { setFound(await api('/me/device-login/lookup', { method: 'POST', body: { request } })); setStage('confirm'); });
  const approve = () => guard(async () => {
    setBadPw(false);
    const { encPrivKey } = await api('/me');
    if (!encPrivKey) throw new Error('This account has no encryption key yet. Log out and back in once, then try again.');
    let sealed;
    try { sealed = await sealIdentityForDevice(encPrivKey, password, found.publicKey); }
    catch { setBadPw(true); setTimeout(() => document.getElementById('sec-ap-pw')?.focus(), 0); return; }
    try {
      await api('/me/device-login/approve', { method: 'POST', body: { request, sealed, password, code: me.twoFactor ? code : undefined } });
    } catch (e) {
      if (e.status === 404) { reset(); setMsg(e.message); return; } // it expired while the person typed
      throw e;
    }
    setPassword(''); setCode(''); setStage('done');
  });
  const deny = () => guard(async () => { await api('/me/device-login/deny', { method: 'POST', body: { request } }); reset(); setMsg('Refused. That device was not signed in.'); });

  const ago = (m) => (m < 1 ? 'just now' : m === 1 ? '1 minute ago' : `${m} minutes ago`);

  if (stage === 'done') return (
    <Section title="Approve a sign-in">
      <p className="ok-text" role="status"><strong>Approved.</strong> The other device is signing in now.</p>
      <div className="notify-actions"><button className="btn" onClick={reset}>Approve another</button></div>
    </Section>
  );

  if (stage === 'confirm' && found) return (
    <Section title="Approve a sign-in">
      <div className="approve-card">
        <p><strong>{found.device}</strong> asked to sign in to your account {ago(found.minutesAgo)}.</p>
        <p className={found.sameNetwork ? 'muted small' : 'error-text small'}>{found.sameNetwork ? 'It is on the same network as this device.' : 'It is NOT on the same network as this device. Only approve it if you started this yourself.'}</p>
      </div>
      <label htmlFor="sec-ap-pw">YOUR PASSWORD</label>
      <input id="sec-ap-pw" aria-invalid={badPw || undefined} aria-describedby={badPw ? 'sec-e-ap-pw' : undefined} type="password" value={password} autoComplete="current-password" disabled={busy} autoFocus
        onChange={(e) => { setPassword(e.target.value); setBadPw(false); }} />
      {badPw && <p className="error-text field-error" id="sec-e-ap-pw" role="alert">That password is not right.</p>}
      {me.twoFactor && <>
        <label>AUTHENTICATOR CODE</label>
        <input value={code} autoComplete="one-time-code" maxLength={20} disabled={busy} placeholder="123456" onChange={(e) => setCode(e.target.value)} />
      </>}
      <p className="hint">Approving gives that device your account and the key that opens your messages. If you did not start this, choose “It is not me”.</p>
      <div className="notify-actions">
        <button className="btn primary" disabled={busy || !password || (me.twoFactor && !code)} onClick={approve}>{busy ? 'Working…' : 'Approve'}</button>
        <button className="btn" disabled={busy} onClick={deny}>It is not me</button>
        <button className="btn" disabled={busy} onClick={reset}>Cancel</button>
      </div>
      {msg && <p className="error-text small" role="alert">{msg}</p>}
    </Section>
  );

  return (
    <Section title="Approve a sign-in">
      <p className="muted">Signing in on a new phone or computer without typing your password? On that device choose <strong>Log in with another device</strong>, then type the code it shows here.</p>
      <label htmlFor="sec-ap-code">CODE FROM THE OTHER DEVICE</label>
      <input id="sec-ap-code" className="device-code-input" value={request} maxLength={12} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="ABCD-EFGH" disabled={busy}
        onChange={(e) => setRequest(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && request && look()} />
      <div className="notify-actions">
        <button className="btn primary" disabled={busy || request.replace(/[\s-]/g, '').length < 8} onClick={look}>{busy ? 'Checking…' : 'Continue'}</button>
      </div>
      {msg && <p className={(msg.startsWith('Refused') ? 'ok-text' : 'error-text') + ' small'} role="alert">{msg}</p>}
    </Section>
  );
}

// Sign out of every device at once (lost or stolen phone, a shared computer you forgot to log out of).
function LogoutEverywhere({ getSocketId }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const run = async () => {
    if (!password || busy) return;
    setBusy(true); setMsg('');
    try {
      await api('/me/logout-all', { method: 'POST', body: { password, socketId: getSocketId?.() || '' } }); // the answer carries this device's new cookie
      await resubscribe();
      location.reload();
    } catch (e) {
      setMsg(e.message || 'Could not do that. Try again.');
      setBusy(false);
    }
  };

  return (
    <Section title="Log out of all devices">
      <p className="muted">If you lost a phone, or logged in on a computer you do not trust, sign out everywhere. Every other device is logged out straight away and stops getting notifications. You stay logged in here.</p>
      <label>YOUR PASSWORD</label>
      <input type="password" value={password} autoComplete="current-password" disabled={busy}
        onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
      <p className="hint">Asked again so that nobody holding a stolen login can lock you out.</p>
      <div className="notify-actions">
        <button className="btn danger" disabled={busy || !password} onClick={run}>{busy ? 'Signing out…' : 'Log out of all devices'}</button>
      </div>
      {msg && <p className="error-text small" role="alert">{msg}</p>}
    </Section>
  );
}

export function SecuritySettings({ me, onSaved, getSocketId }) {
  return (
    <div className="security-settings">
      <ChangePassword me={me} getSocketId={getSocketId} />
      <RecoveryKey me={me} onSaved={onSaved} />
      <EmailRecovery me={me} onSaved={onSaved} />
      <TwoFactor me={me} onSaved={onSaved} />
      <Passkeys me={me} onSaved={onSaved} />
      <ApproveSignIn me={me} />
      <LogoutEverywhere getSocketId={getSocketId} />
    </div>
  );
}
