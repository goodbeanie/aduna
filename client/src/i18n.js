import { useSyncExternalStore } from 'react';

// Languages Aduna can be shown in. The server keeps the same list (LANGS in server/index.js).
export const LANGS = [['en', 'English'], ['fr', 'Français'], ['es', 'Español']];

const KEY = 'aduna-lang';
const ok = (c) => LANGS.some(([k]) => k === c);

function detect() {
  try { const s = localStorage.getItem(KEY); if (ok(s)) return s; } catch { /* private mode */ }
  const n = String((typeof navigator !== 'undefined' && navigator.language) || 'en').slice(0, 2).toLowerCase();
  return ok(n) ? n : 'en';
}

let cur = detect();
const subs = new Set();
if (typeof document !== 'undefined') document.documentElement.lang = cur;

export const getLang = () => cur;
// Switches the language everywhere at once. It is remembered on this device; the account keeps its own copy (PATCH /api/me { lang }).
export function setLang(code) {
  if (!ok(code) || code === cur) return;
  cur = code;
  try { localStorage.setItem(KEY, code); } catch { /* private mode */ }
  if (typeof document !== 'undefined') document.documentElement.lang = code;
  subs.forEach((f) => f());
}

// Anything not translated yet falls back to English, so a missing word never shows as a blank.
export function t(key, vars) {
  const s = (D[cur] && D[cur][key]) ?? D.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')) : s;
}

// Call this in a component so it redraws when the language changes.
export function useLang() {
  useSyncExternalStore((fn) => { subs.add(fn); return () => subs.delete(fn); }, () => cur);
  return { lang: cur, t };
}

const D = {
  en: {
    // sign in / sign up
    welcomeBack: 'Welcome back!', excited: "We're so excited to see you again!",
    resetTitle: 'Reset your password', createTitle: 'Create an account',
    resetKeyHelp: 'Use the recovery key you saved. Your messages stay readable.',
    resetMailHelp: 'We can email a reset link to the address on the account, if you turned email recovery on.',
    joinConv: 'Join the conversation. DMs are end-to-end encrypted.',
    username: 'USERNAME', email: 'EMAIL',
    emailHint: "Never shown to other people. We'll email you a code to verify it, and use it for payment receipts and important account notices.",
    recoveryKeyBtn: 'Recovery key', emailLinkBtn: 'Email me a link', recoveryKeyLabel: 'RECOVERY KEY',
    recoveryHelp: 'Your password also locks your encryption key, so the recovery key is what keeps your messages readable. No key? Try “Email me a link” if you turned it on in Settings.',
    newPassword: 'NEW PASSWORD', password: 'PASSWORD',
    passwordHint: 'At least 8 characters. Your password also protects your encryption key. You can change the password in Settings > Security.',
    ifForget: 'IF YOU FORGET YOUR PASSWORD', chooseBack: 'Choose how you want to get back in. Pick one or both.',
    keyOptionB: 'Recovery key', keyOptionT: ': a key you save yourself. Your messages stay readable.',
    mailOptionB: 'Email recovery', mailOptionT: ': we email you a reset link. This makes a new encryption key, so older direct messages become unreadable.',
    mailUnavailable: ' (Not available on this server yet.)',
    newPasswordAgain: 'NEW PASSWORD AGAIN', forgot: 'Forgot your password?',
    authCode: 'AUTHENTICATOR CODE',
    authCodeHint: 'Open your authenticator app and enter the 6-digit code. Lost your phone? Enter one of your recovery codes instead (each works once).',
    working: 'Working…', logIn: 'Log In', sendAgain: 'Send the link again', sendLink: 'Send me a link', resetBtn: 'Reset password', continue: 'Continue',
    needAccount: 'Need an account? ', remembered: 'Remembered it? ', haveAccount: 'Already have an account? ', register: 'Register', logInLink: 'Log in',
    // first-time setup
    setupTitle: 'Set up Aduna',
    setupSub: 'Pick your language and you are ready to go. You can change it later in Settings.',
    language: 'LANGUAGE', joinAduna: 'Join the Aduna server',
    joinAdunaHint: 'The official community: news, help and people to chat with. You can leave it any time.',
    finish: 'Finish setup', saving: 'Saving…',
    // settings
    settings: 'Settings', tabProfile: 'My profile', tabAppearance: 'Appearance', tabLanguage: 'Language', tabNotifications: 'Notifications',
    tabSecurity: 'Security', tabDeveloper: 'Developer', tabBadges: 'Badges', logOut: 'Log out',
    closeSettings: 'Close settings', closeEsc: 'Close (Esc)',
    langHelp: 'Choose the language Aduna is shown in. Some parts of the app are still in English while translations are added.',
    langSaved: 'Saved',
  },
  fr: {
    welcomeBack: 'Bon retour !', excited: 'Nous sommes ravis de vous revoir !',
    resetTitle: 'Réinitialisez votre mot de passe', createTitle: 'Créer un compte',
    resetKeyHelp: 'Utilisez la clé de récupération que vous avez enregistrée. Vos messages restent lisibles.',
    resetMailHelp: "Nous pouvons envoyer un lien de réinitialisation à l'adresse du compte, si vous avez activé la récupération par e-mail.",
    joinConv: 'Rejoignez la conversation. Les messages privés sont chiffrés de bout en bout.',
    username: "NOM D'UTILISATEUR", email: 'E-MAIL',
    emailHint: "Jamais visible par les autres. Nous vous enverrons un code pour la vérifier, et nous l'utiliserons pour les reçus de paiement et les avis importants sur le compte.",
    recoveryKeyBtn: 'Clé de récupération', emailLinkBtn: 'Envoyez-moi un lien', recoveryKeyLabel: 'CLÉ DE RÉCUPÉRATION',
    recoveryHelp: "Votre mot de passe verrouille aussi votre clé de chiffrement : c'est la clé de récupération qui garde vos messages lisibles. Pas de clé ? Essayez « Envoyez-moi un lien » si vous l'avez activé dans les paramètres.",
    newPassword: 'NOUVEAU MOT DE PASSE', password: 'MOT DE PASSE',
    passwordHint: 'Au moins 8 caractères. Votre mot de passe protège aussi votre clé de chiffrement. Vous pouvez le changer dans Paramètres > Sécurité.',
    ifForget: 'SI VOUS OUBLIEZ VOTRE MOT DE PASSE', chooseBack: "Choisissez comment retrouver l'accès. Une option ou les deux.",
    keyOptionB: 'Clé de récupération', keyOptionT: ' : une clé que vous conservez vous-même. Vos messages restent lisibles.',
    mailOptionB: 'Récupération par e-mail', mailOptionT: ' : nous vous envoyons un lien de réinitialisation. Cela crée une nouvelle clé de chiffrement : les anciens messages privés deviennent illisibles.',
    mailUnavailable: ' (Pas encore disponible sur ce serveur.)',
    newPasswordAgain: 'NOUVEAU MOT DE PASSE (ENCORE)', forgot: 'Mot de passe oublié ?',
    authCode: "CODE DE L'APPLICATION D'AUTHENTIFICATION",
    authCodeHint: "Ouvrez votre application d'authentification et saisissez le code à 6 chiffres. Téléphone perdu ? Saisissez plutôt un de vos codes de récupération (chacun ne sert qu'une fois).",
    working: 'Un instant…', logIn: 'Se connecter', sendAgain: 'Renvoyer le lien', sendLink: 'Envoyez-moi un lien', resetBtn: 'Réinitialiser le mot de passe', continue: 'Continuer',
    needAccount: "Besoin d'un compte ? ", remembered: 'Vous vous en souvenez ? ', haveAccount: 'Vous avez déjà un compte ? ', register: "S'inscrire", logInLink: 'Se connecter',
    setupTitle: 'Configurer Aduna',
    setupSub: "Choisissez votre langue et c'est parti. Vous pourrez la modifier plus tard dans les paramètres.",
    language: 'LANGUE', joinAduna: 'Rejoindre le serveur Aduna',
    joinAdunaHint: 'La communauté officielle : actualités, aide et des gens avec qui discuter. Vous pouvez la quitter à tout moment.',
    finish: 'Terminer', saving: 'Enregistrement…',
    settings: 'Paramètres', tabProfile: 'Mon profil', tabAppearance: 'Apparence', tabLanguage: 'Langue', tabNotifications: 'Notifications',
    tabSecurity: 'Sécurité', tabDeveloper: 'Développeur', tabBadges: 'Badges', logOut: 'Se déconnecter',
    closeSettings: 'Fermer les paramètres', closeEsc: 'Fermer (Échap)',
    langHelp: "Choisissez la langue d'affichage d'Aduna. Certaines parties de l'application restent en anglais le temps que les traductions soient ajoutées.",
    langSaved: 'Enregistré',
  },
  es: {
    welcomeBack: '¡Bienvenido de nuevo!', excited: '¡Qué alegría verte otra vez!',
    resetTitle: 'Restablece tu contraseña', createTitle: 'Crear una cuenta',
    resetKeyHelp: 'Usa la clave de recuperación que guardaste. Tus mensajes seguirán siendo legibles.',
    resetMailHelp: 'Podemos enviar un enlace de restablecimiento al correo de la cuenta, si activaste la recuperación por correo.',
    joinConv: 'Únete a la conversación. Los mensajes directos están cifrados de extremo a extremo.',
    username: 'NOMBRE DE USUARIO', email: 'CORREO ELECTRÓNICO',
    emailHint: 'Nunca se muestra a otras personas. Te enviaremos un código para verificarlo y lo usaremos para recibos de pago y avisos importantes de la cuenta.',
    recoveryKeyBtn: 'Clave de recuperación', emailLinkBtn: 'Envíame un enlace', recoveryKeyLabel: 'CLAVE DE RECUPERACIÓN',
    recoveryHelp: 'Tu contraseña también protege tu clave de cifrado, así que la clave de recuperación es lo que mantiene legibles tus mensajes. ¿Sin clave? Prueba «Envíame un enlace» si lo activaste en Ajustes.',
    newPassword: 'NUEVA CONTRASEÑA', password: 'CONTRASEÑA',
    passwordHint: 'Al menos 8 caracteres. Tu contraseña también protege tu clave de cifrado. Puedes cambiarla en Ajustes > Seguridad.',
    ifForget: 'SI OLVIDAS TU CONTRASEÑA', chooseBack: 'Elige cómo quieres recuperar el acceso. Una opción o ambas.',
    keyOptionB: 'Clave de recuperación', keyOptionT: ': una clave que guardas tú. Tus mensajes seguirán siendo legibles.',
    mailOptionB: 'Recuperación por correo', mailOptionT: ': te enviamos un enlace de restablecimiento. Esto crea una nueva clave de cifrado, por lo que los mensajes directos anteriores dejan de ser legibles.',
    mailUnavailable: ' (Aún no disponible en este servidor.)',
    newPasswordAgain: 'REPITE LA NUEVA CONTRASEÑA', forgot: '¿Olvidaste tu contraseña?',
    authCode: 'CÓDIGO DE AUTENTICACIÓN',
    authCodeHint: 'Abre tu app de autenticación e introduce el código de 6 dígitos. ¿Perdiste el teléfono? Introduce uno de tus códigos de recuperación (cada uno sirve una sola vez).',
    working: 'Procesando…', logIn: 'Iniciar sesión', sendAgain: 'Enviar el enlace otra vez', sendLink: 'Envíame un enlace', resetBtn: 'Restablecer contraseña', continue: 'Continuar',
    needAccount: '¿Necesitas una cuenta? ', remembered: '¿Ya te acordaste? ', haveAccount: '¿Ya tienes una cuenta? ', register: 'Regístrate', logInLink: 'Inicia sesión',
    setupTitle: 'Configura Aduna',
    setupSub: 'Elige tu idioma y listo. Podrás cambiarlo más tarde en Ajustes.',
    language: 'IDIOMA', joinAduna: 'Unirme al servidor de Aduna',
    joinAdunaHint: 'La comunidad oficial: novedades, ayuda y gente con quien charlar. Puedes salir cuando quieras.',
    finish: 'Terminar', saving: 'Guardando…',
    settings: 'Ajustes', tabProfile: 'Mi perfil', tabAppearance: 'Apariencia', tabLanguage: 'Idioma', tabNotifications: 'Notificaciones',
    tabSecurity: 'Seguridad', tabDeveloper: 'Desarrollador', tabBadges: 'Insignias', logOut: 'Cerrar sesión',
    closeSettings: 'Cerrar ajustes', closeEsc: 'Cerrar (Esc)',
    langHelp: 'Elige el idioma en el que se muestra Aduna. Algunas partes de la app siguen en inglés mientras se añaden las traducciones.',
    langSaved: 'Guardado',
  },
};
