import { getLang, onLang } from './i18n.js';

// A phrasebook for the parts of the app that have not been moved to t('key') yet. It translates the text the page is already
// showing: every text node, placeholder, title and aria-label that matches an English phrase below exactly (ignoring spaces
// around it) is swapped for the French or Spanish one, and put back if the language changes. People's own messages are never touched.
// To add a phrase: add a line [English, Français, Español]. Anything not listed stays English.
const BOOK = [
  // main screen
  ['Add category', 'Ajouter une catégorie', 'Añadir categoría'], ['Create channel', 'Créer un salon', 'Crear canal'],
  ['Create or join a server', 'Créer ou rejoindre un serveur', 'Crear o unirse a un servidor'], ['End-to-end encrypted', 'Chiffré de bout en bout', 'Cifrado de extremo a extremo'],
  ['Everyone in this server is notified when the owner posts here.', 'Tout le monde sur ce serveur est notifié quand le propriétaire publie ici.', 'Todos en este servidor reciben una notificación cuando el propietario publica aquí.'],
  ['Invite people', 'Inviter des gens', 'Invitar personas'], ['Leave server', 'Quitter le serveur', 'Salir del servidor'], ['Leave voice', 'Quitter le vocal', 'Salir de la voz'],
  ['Loading Aduna', 'Chargement d’Aduna', 'Cargando Aduna'], ['Mark all as read', 'Tout marquer comme lu', 'Marcar todo como leído'], ['Members', 'Membres', 'Miembros'],
  ['Messages here are end-to-end encrypted. Only you and', 'Les messages ici sont chiffrés de bout en bout. Seuls vous et', 'Los mensajes aquí están cifrados de extremo a extremo. Solo tú y'],
  ['Mute server…', 'Mettre le serveur en sourdine…', 'Silenciar servidor…'], ['Unmute server', 'Réactiver le serveur', 'Dejar de silenciar el servidor'],
  ['Notification settings', 'Paramètres de notification', 'Ajustes de notificaciones'], ['Server owner', 'Propriétaire du serveur', 'Propietario del servidor'],
  ['Server questions', 'Questions du serveur', 'Preguntas del servidor'], ['Server settings', 'Paramètres du serveur', 'Ajustes del servidor'],
  ['Show members', 'Afficher les membres', 'Mostrar miembros'], ['Video call', 'Appel vidéo', 'Videollamada'], ['Voice call', 'Appel vocal', 'Llamada de voz'],
  ['You were mentioned', 'Vous avez été mentionné', 'Te mencionaron'],
  // common buttons and words
  ['Close', 'Fermer', 'Cerrar'], ['Cancel', 'Annuler', 'Cancelar'], ['Back', 'Retour', 'Atrás'], ['Back to list', 'Retour à la liste', 'Volver a la lista'],
  ['Delete', 'Supprimer', 'Eliminar'], ['Save', 'Enregistrer', 'Guardar'], ['Save changes', 'Enregistrer les modifications', 'Guardar cambios'],
  ['Create', 'Créer', 'Crear'], ['Add', 'Ajouter', 'Añadir'], ['Remove', 'Retirer', 'Quitar'], ['Edit', 'Modifier', 'Editar'], ['Done', 'Terminé', 'Listo'],
  ['Loading…', 'Chargement…', 'Cargando…'], ['Copy', 'Copier', 'Copiar'], ['Copied!', 'Copié !', '¡Copiado!'], ['Download', 'Télécharger', 'Descargar'],
  ['Open', 'Ouvrir', 'Abrir'], ['Later', 'Plus tard', 'Más tarde'], ['Try again', 'Réessayer', 'Intentar de nuevo'], ['Refresh', 'Actualiser', 'Actualizar'],
  ['Accept', 'Accepter', 'Aceptar'], ['Decline', 'Refuser', 'Rechazar'], ['Reply', 'Répondre', 'Responder'], ['Send', 'Envoyer', 'Enviar'], ['Search', 'Rechercher', 'Buscar'],
  ['Name', 'Nom', 'Nombre'], ['Colour', 'Couleur', 'Color'], ['Type', 'Type', 'Tipo'], ['Visibility', 'Visibilité', 'Visibilidad'], ['Emoji', 'Émoji', 'Emoji'],
  ['Channels', 'Salons', 'Canales'], ['Roles', 'Rôles', 'Roles'], ['Credits', 'Crédits', 'Créditos'], ['Overview', 'Aperçu', 'Resumen'], ['Profile', 'Profil', 'Perfil'],
  ['Member', 'Membre', 'Miembro'], ['Gallery', 'Galerie', 'Galería'], ['Browse', 'Parcourir', 'Explorar'], ['Explorer', 'Explorateur', 'Explorador'],
  ['Light', 'Clair', 'Claro'], ['Dark', 'Sombre', 'Oscuro'], ['Live', 'En direct', 'En vivo'], ['Camera', 'Caméra', 'Cámara'], ['Call', 'Appeler', 'Llamar'],
  ['Hang up', 'Raccrocher', 'Colgar'], ['Leave', 'Quitter', 'Salir'], ['Kick', 'Expulser', 'Expulsar'], ['Report', 'Signaler', 'Denunciar'], ['Tab', 'Tab', 'Tab'],
  ['Move up', 'Monter', 'Subir'], ['Move down', 'Descendre', 'Bajar'], ['Required', 'Obligatoire', 'Obligatorio'], ['Unmute', 'Réactiver le son', 'Dejar de silenciar'],
  ['Publish', 'Publier', 'Publicar'], ['Unpublish', 'Dépublier', 'Dejar de publicar'], ['Rename', 'Renommer', 'Renombrar'],
  // chat
  ['Add reaction', 'Ajouter une réaction', 'Añadir reacción'], ['Attach', 'Joindre', 'Adjuntar'], ['Cancel reply', 'Annuler la réponse', 'Cancelar respuesta'],
  ['Delete message', 'Supprimer le message', 'Eliminar mensaje'], ['Drop files to send', 'Déposez des fichiers pour les envoyer', 'Suelta archivos para enviarlos'],
  ['Files', 'Fichiers', 'Archivos'], ['No messages yet. Say hello.', 'Aucun message pour l’instant. Dites bonjour.', 'Aún no hay mensajes. Saluda.'],
  ['Original message was deleted or isn\'t loaded', 'Le message d’origine a été supprimé ou n’est pas chargé', 'El mensaje original se eliminó o no está cargado'],
  ['Poll', 'Sondage', 'Encuesta'], ['Replying to', 'Réponse à', 'Respondiendo a'],
  ['This permanently removes the message for everyone in this conversation.', 'Cela supprime définitivement le message pour tous les participants de cette conversation.', 'Esto elimina el mensaje de forma permanente para todos en esta conversación.'],
  ['escape to', 'Échap pour', 'Esc para'], ['· enter to', '· Entrée pour', '· Intro para'],
  ['Nobody is in this voice channel yet.', 'Personne n’est encore dans ce salon vocal.', 'Todavía no hay nadie en este canal de voz.'],
  ['Incoming call', 'Appel entrant', 'Llamada entrante'], ['is calling you…', 'vous appelle…', 'te está llamando…'],
  // modals
  ['ABOUT ME', 'À PROPOS DE MOI', 'SOBRE MÍ'], ['Accept friend request', 'Accepter la demande d’ami', 'Aceptar solicitud de amistad'], ['Add friend', 'Ajouter un ami', 'Añadir amigo'],
  ['Add friends to send them an invite directly.', 'Ajoutez des amis pour leur envoyer une invitation directement.', 'Añade amigos para enviarles una invitación directamente.'],
  ['CATEGORY NAME', 'NOM DE LA CATÉGORIE', 'NOMBRE DE LA CATEGORÍA'], ['CHANNEL NAME', 'NOM DU SALON', 'NOMBRE DEL CANAL'], ['CHANNEL TYPE', 'TYPE DE SALON', 'TIPO DE CANAL'],
  ['Channel type', 'Type de salon', 'Tipo de canal'], ['DIRECT INVITE', 'INVITATION DIRECTE', 'INVITACIÓN DIRECTA'], ['Edit profile', 'Modifier le profil', 'Editar perfil'],
  ['Friend request sent', 'Demande d’ami envoyée', 'Solicitud de amistad enviada'], ['INVITE LINK', 'LIEN D’INVITATION', 'ENLACE DE INVITACIÓN'],
  ['INVITE LINK OR CODE', 'LIEN OU CODE D’INVITATION', 'ENLACE O CÓDIGO DE INVITACIÓN'], ['Join with invite', 'Rejoindre avec une invitation', 'Unirse con invitación'],
  ['MEMBER SINCE', 'MEMBRE DEPUIS', 'MIEMBRO DESDE'], ['Messages with', 'Les messages avec', 'Los mensajes con'], ['New category', 'Nouvelle catégorie', 'Nueva categoría'],
  ['No friends match.', 'Aucun ami ne correspond.', 'Ningún amigo coincide.'], ['SERVER NAME', 'NOM DU SERVEUR', 'NOMBRE DEL SERVIDOR'],
  ['Search your friends…', 'Rechercher parmi vos amis…', 'Buscar entre tus amigos…'], ['Send encrypted message', 'Envoyer un message chiffré', 'Enviar mensaje cifrado'],
  ['Start a conversation', 'Démarrer une conversation', 'Iniciar una conversación'], ['Verify encryption', 'Vérifier le chiffrement', 'Verificar el cifrado'],
  ['You can message friends. Add one from the Friends page first.', 'Vous pouvez écrire à vos amis. Ajoutez-en un depuis la page Amis d’abord.', 'Puedes escribir a tus amigos. Primero añade uno desde la página Amigos.'],
  ['are end-to-end encrypted: the server only stores scrambled data.', 'sont chiffrés de bout en bout : le serveur ne stocke que des données brouillées.', 'están cifrados de extremo a extremo: el servidor solo guarda datos codificados.'],
  // invites
  ['Go to Aduna', 'Aller sur Aduna', 'Ir a Aduna'], ['Invite no longer valid', 'Invitation expirée', 'Invitación no válida'], ['Server invite', 'Invitation de serveur', 'Invitación al servidor'],
  ['The code was changed or the server is gone.', 'Le code a été modifié ou le serveur n’existe plus.', 'El código cambió o el servidor ya no existe.'],
  ['The link was changed or the server is gone.', 'Le lien a été modifié ou le serveur n’existe plus.', 'El enlace cambió o el servidor ya no existe.'],
  ['You can\'t join this server', 'Vous ne pouvez pas rejoindre ce serveur', 'No puedes unirte a este servidor'],
  // explorer
  ['Add to server', 'Ajouter au serveur', 'Añadir al servidor'], ['Clear search', 'Effacer la recherche', 'Borrar búsqueda'], ['Search bots', 'Rechercher des bots', 'Buscar bots'],
  ['Search bots by name, description or tag', 'Rechercher des bots par nom, description ou tag', 'Buscar bots por nombre, descripción o etiqueta'], ['Search servers', 'Rechercher des serveurs', 'Buscar servidores'],
  ['Search servers by name, description or tag', 'Rechercher des serveurs par nom, description ou tag', 'Buscar servidores por nombre, descripción o etiqueta'], ['Sort by', 'Trier par', 'Ordenar por'],
  ['Thank you. Your report was sent. The server owner is not told who reported.', 'Merci. Votre signalement a été envoyé. Le propriétaire du serveur ne sait pas qui l’a fait.', 'Gracias. Tu denuncia fue enviada. Al propietario del servidor no se le dice quién denunció.'],
  ['What is wrong with this listing?', 'Quel est le problème avec cette fiche ?', '¿Qué le pasa a esta ficha?'],
  // credits
  ['Shop', 'Boutique', 'Tienda'], ['Owned', 'Possédé', 'Obtenido'],
  ['Spend your credits on badges that show next to your name everywhere in Aduna. Each one is yours to keep.', 'Dépensez vos crédits en badges qui s’affichent à côté de votre nom partout dans Aduna. Chacun est à vous pour toujours.', 'Gasta tus créditos en insignias que aparecen junto a tu nombre en todo Aduna. Cada una es tuya para siempre.'],
  ['Aduna credits', 'Crédits Aduna', 'Créditos de Aduna'], ['Aduna does not save your payment information, your security is our priority.', 'Aduna n’enregistre pas vos informations de paiement : votre sécurité est notre priorité.', 'Aduna no guarda tu información de pago: tu seguridad es nuestra prioridad.'],
  ['Buy credits', 'Acheter des crédits', 'Comprar créditos'], ['Buying credits is not set up on this server yet.', 'L’achat de crédits n’est pas encore configuré sur ce serveur.', 'La compra de créditos aún no está configurada en este servidor.'],
  ['Cancel checkout', 'Annuler le paiement', 'Cancelar el pago'], ['Checkout', 'Paiement', 'Pago'], ['Choose where you are', 'Choisissez où vous êtes', 'Elige dónde estás'], ['Choose your country', 'Choisissez votre pays', 'Elige tu país'],
  ['Daily quests', 'Quêtes quotidiennes', 'Misiones diarias'], ['Earn by chatting', 'Gagnez en discutant', 'Gana chateando'], ['Loading secure checkout…', 'Chargement du paiement sécurisé…', 'Cargando el pago seguro…'],
  ['Nothing yet.', 'Rien pour l’instant.', 'Nada todavía.'], ['Order summary', 'Récapitulatif de la commande', 'Resumen del pedido'], ['Quests', 'Quêtes', 'Misiones'], ['Recent activity', 'Activité récente', 'Actividad reciente'],
  ['Somewhere else', 'Ailleurs', 'Otro lugar'], ['Subtotal', 'Sous-total', 'Subtotal'], ['Tax', 'Taxe', 'Impuesto'], ['Total due today', 'Total à payer aujourd’hui', 'Total a pagar hoy'],
  ['Thank you! Your credits are added as soon as the payment is confirmed, usually within seconds.', 'Merci ! Vos crédits sont ajoutés dès que le paiement est confirmé, généralement en quelques secondes.', '¡Gracias! Tus créditos se añaden en cuanto se confirma el pago, normalmente en segundos.'],
  ['Type it yourself. Pasted or auto-typed text earns nothing.', 'Écrivez-le vous-même. Le texte collé ou saisi automatiquement ne rapporte rien.', 'Escríbelo tú. El texto pegado o escrito automáticamente no da nada.'],
  ['Write real messages in server channels and earn', 'Écrivez de vrais messages dans les salons des serveurs et gagnez', 'Escribe mensajes reales en los canales de los servidores y gana'],
  ['Name on card', 'Nom sur la carte', 'Nombre en la tarjeta'], ['Card number', 'Numéro de carte', 'Número de tarjeta'], ['MM / YY', 'MM / AA', 'MM / AA'], ['CVV', 'CVV', 'CVV'],
  // emoji / GIF
  ['Add custom emoji', 'Ajouter un émoji personnalisé', 'Añadir emoji personalizado'], ['ADD AN EMOJI', 'AJOUTER UN ÉMOJI', 'AÑADIR UN EMOJI'], ['Choose image', 'Choisir une image', 'Elegir imagen'],
  ['Choose skin tone', 'Choisir la teinte de peau', 'Elegir tono de piel'], ['Custom emoji', 'Émojis personnalisés', 'Emojis personalizados'], ['In your emoji', 'Dans vos émojis', 'En tus emojis'],
  ['Loading emoji…', 'Chargement des émojis…', 'Cargando emojis…'], ['Pick an emoji', 'Choisir un émoji', 'Elige un emoji'], ['Report emoji', 'Signaler l’émoji', 'Denunciar emoji'],
  ['Save to my emoji', 'Ajouter à mes émojis', 'Guardar en mis emojis'], ['Search emoji', 'Rechercher un émoji', 'Buscar emoji'], ['Skin tone', 'Teinte de peau', 'Tono de piel'],
  ['This emoji is no longer available', 'Cet émoji n’est plus disponible', 'Este emoji ya no está disponible'], ['YOUR EMOJI', 'VOS ÉMOJIS', 'TUS EMOJIS'],
  ['Nothing yet. Add one, or click an emoji in a message to save it.', 'Rien pour l’instant. Ajoutez-en un ou cliquez sur un émoji dans un message pour l’enregistrer.', 'Nada todavía. Añade uno o haz clic en un emoji de un mensaje para guardarlo.'],
  ['2 to 32 letters, numbers or underscores', 'De 2 à 32 lettres, chiffres ou tirets bas', 'De 2 a 32 letras, números o guiones bajos'],
  ['GIF search isn’t set up yet', 'La recherche de GIF n’est pas encore configurée', 'La búsqueda de GIF aún no está configurada'], ['No GIFs found.', 'Aucun GIF trouvé.', 'No se encontraron GIF.'],
  ['Search GIFs', 'Rechercher des GIF', 'Buscar GIF'], ['That’s everything.', 'C’est tout.', 'Eso es todo.'],
  ['Powered by GIPHY. Viewing a GIF loads it from GIPHY.', 'Propulsé par GIPHY. Afficher un GIF le charge depuis GIPHY.', 'Con tecnología de GIPHY. Ver un GIF lo carga desde GIPHY.'],
  // security, recovery, passwords, verification
  ['CURRENT PASSWORD', 'MOT DE PASSE ACTUEL', 'CONTRASEÑA ACTUAL'], ['YOUR PASSWORD', 'VOTRE MOT DE PASSE', 'TU CONTRASEÑA'], ['Change password', 'Changer le mot de passe', 'Cambiar contraseña'],
  ['Copy codes', 'Copier les codes', 'Copiar códigos'], ['I saved them', 'Je les ai enregistrés', 'Los guardé'], ['Log out of all devices', 'Se déconnecter de tous les appareils', 'Cerrar sesión en todos los dispositivos'],
  ['Open in my authenticator app', 'Ouvrir dans mon application d’authentification', 'Abrir en mi app de autenticación'], ['Two-factor login', 'Connexion en deux étapes', 'Inicio de sesión en dos pasos'],
  ['Two-factor is on.', 'La double authentification est activée.', 'La verificación en dos pasos está activada.'], ['Your new recovery key', 'Votre nouvelle clé de récupération', 'Tu nueva clave de recuperación'],
  ['Save these recovery codes now. Each one works once if you lose your phone, and they are not shown again.', 'Enregistrez ces codes de récupération maintenant. Chacun ne sert qu’une fois si vous perdez votre téléphone, et ils ne seront plus affichés.', 'Guarda estos códigos de recuperación ahora. Cada uno sirve una vez si pierdes el teléfono y no se volverán a mostrar.'],
  ['Asked again so that nobody holding a stolen login can lock you out.', 'Demandé de nouveau pour que personne avec une session volée ne puisse vous bloquer.', 'Se pide otra vez para que nadie con una sesión robada pueda dejarte fuera.'],
  ['I saved my recovery key somewhere safe', 'J’ai enregistré ma clé de récupération en lieu sûr', 'Guardé mi clave de recuperación en un lugar seguro'], ['Save as file', 'Enregistrer en fichier', 'Guardar como archivo'],
  ['way back in with your encrypted messages intact. We never see it and cannot show it again.', 'pour retrouver l’accès avec vos messages chiffrés intacts. Nous ne la voyons jamais et ne pouvons pas la réafficher.', 'para volver a entrar con tus mensajes cifrados intactos. Nunca la vemos y no podemos mostrarla otra vez.'],
  ['Checking your link…', 'Vérification de votre lien…', 'Comprobando tu enlace…'], ['Choose a new password', 'Choisissez un nouveau mot de passe', 'Elige una nueva contraseña'], ['Save your new recovery key', 'Enregistrez votre nouvelle clé de récupération', 'Guarda tu nueva clave de recuperación'],
  ['Back to log in to ask for a new link', 'Retour à la connexion pour demander un nouveau lien', 'Volver al inicio de sesión para pedir un nuevo enlace'],
  ['Resend code', 'Renvoyer le code', 'Reenviar código'], ['VERIFICATION CODE', 'CODE DE VÉRIFICATION', 'CÓDIGO DE VERIFICACIÓN'], ['Wrong email?', 'Mauvais e-mail ?', '¿Correo equivocado?'],
  ['Please add an email address so we can verify your account.', 'Ajoutez une adresse e-mail pour que nous puissions vérifier votre compte.', 'Añade una dirección de correo para que podamos verificar tu cuenta.'],
  ['We sent a 6-digit code to', 'Nous avons envoyé un code à 6 chiffres à', 'Enviamos un código de 6 dígitos a'],
  // notifications / updates
  ['Add to Home Screen', 'Sur l’écran d’accueil', 'Añadir a la pantalla de inicio'], ['Turn on', 'Activer', 'Activar'],
  ['Get notified about DMs, mentions and calls, even when Aduna is closed.', 'Soyez notifié des messages privés, mentions et appels, même quand Aduna est fermé.', 'Recibe avisos de mensajes directos, menciones y llamadas, incluso con Aduna cerrado.'],
  ['Aduna was updated', 'Aduna a été mis à jour', 'Aduna se actualizó'], ['Reload', 'Recharger', 'Recargar'], ['Reload to get the newest version.', 'Rechargez pour obtenir la dernière version.', 'Recarga para obtener la versión más reciente.'],
  ['Update', 'Mettre à jour', 'Actualizar'], ['Update available', 'Mise à jour disponible', 'Actualización disponible'], ['Downloading', 'Téléchargement', 'Descargando'],
  // server settings
  ['Add a tag', 'Ajouter un tag', 'Añadir etiqueta'], ['Add by username', 'Ajouter par nom d’utilisateur', 'Añadir por nombre de usuario'], ['Authenticator code', 'Code d’authentification', 'Código de autenticación'],
  ['Background', 'Arrière-plan', 'Fondo'], ['COMMUNITY THEMES', 'THÈMES DE LA COMMUNAUTÉ', 'TEMAS DE LA COMUNIDAD'], ['CUSTOM INVITE LINK ENDING', 'FIN DU LIEN D’INVITATION PERSONNALISÉ', 'FINAL DEL ENLACE DE INVITACIÓN PERSONALIZADO'],
  ['Change banner', 'Changer la bannière', 'Cambiar banner'], ['Change server banner', 'Changer la bannière du serveur', 'Cambiar el banner del servidor'], ['Change server icon', 'Changer l’icône du serveur', 'Cambiar el icono del servidor'],
  ['Choose a member…', 'Choisir un membre…', 'Elige un miembro…'], ['Close server settings', 'Fermer les paramètres du serveur', 'Cerrar ajustes del servidor'], ['Delete category', 'Supprimer la catégorie', 'Eliminar categoría'],
  ['Delete channel', 'Supprimer le salon', 'Eliminar canal'], ['Delete server', 'Supprimer le serveur', 'Eliminar servidor'], ['Delete server…', 'Supprimer le serveur…', 'Eliminar servidor…'],
  ['ICON AND BANNER', 'ICÔNE ET BANNIÈRE', 'ICONO Y BANNER'], ['NO CATEGORY', 'SANS CATÉGORIE', 'SIN CATEGORÍA'], ['No category', 'Sans catégorie', 'Sin categoría'], ['New owner', 'Nouveau propriétaire', 'Nuevo propietario'],
  ['No channels in this category.', 'Aucun salon dans cette catégorie.', 'No hay canales en esta categoría.'], ['No server theme', 'Aucun thème de serveur', 'Sin tema de servidor'], ['OR CHOOSE YOUR OWN', 'OU CHOISISSEZ LE VÔTRE', 'O ELIGE EL TUYO'],
  ['Ownership', 'Propriété', 'Propiedad'], ['PEOPLE WHO CAN JOIN', 'PERSONNES POUVANT REJOINDRE', 'PERSONAS QUE PUEDEN UNIRSE'], ['Public only', 'Public uniquement', 'Solo público'], ['Publish this theme to the gallery…', 'Publier ce thème dans la galerie…', 'Publicar este tema en la galería…'],
  ['Remove banner', 'Retirer la bannière', 'Quitar banner'], ['Remove icon', 'Retirer l’icône', 'Quitar icono'], ['START FROM A PRESET', 'PARTIR D’UN MODÈLE', 'EMPEZAR DESDE UN PRESET'],
  ['Server accent colour', 'Couleur d’accent du serveur', 'Color de acento del servidor'], ['Server background colour', 'Couleur d’arrière-plan du serveur', 'Color de fondo del servidor'], ['Server theme', 'Thème du serveur', 'Tema del servidor'],
  ['Theme base', 'Base du thème', 'Base del tema'], ['Transfer ownership', 'Transférer la propriété', 'Transferir la propiedad'], ['Transfer ownership…', 'Transférer la propriété…', 'Transferir la propiedad…'],
  ['Use a server theme', 'Utiliser un thème de serveur', 'Usar un tema de servidor'], ['What is your server about?', 'De quoi parle votre serveur ?', '¿De qué trata tu servidor?'], ['Your password', 'Votre mot de passe', 'Tu contraseña'],
  ['to confirm', 'pour confirmer', 'para confirmar'], ['Needs rules + announcements', 'Nécessite des règles + des annonces', 'Requiere reglas + anuncios'],
  ['A server needs at least one channel, so the last one cannot be deleted.', 'Un serveur doit avoir au moins un salon : le dernier ne peut pas être supprimé.', 'Un servidor necesita al menos un canal, así que el último no se puede eliminar.'],
  ['Changes here apply right away. You can also drag channels and categories in the channel list to reorder them.', 'Les changements s’appliquent immédiatement. Vous pouvez aussi faire glisser les salons et catégories dans la liste pour les réordonner.', 'Los cambios se aplican al instante. También puedes arrastrar canales y categorías en la lista para reordenarlos.'],
  ['Changing the code stops the old one from working, including invite links already shared.', 'Changer le code désactive l’ancien, y compris les liens d’invitation déjà partagés.', 'Cambiar el código desactiva el anterior, incluidos los enlaces de invitación ya compartidos.'],
  ['You are the only member. Invite someone first, or delete the server.', 'Vous êtes le seul membre. Invitez quelqu’un d’abord, ou supprimez le serveur.', 'Eres el único miembro. Invita a alguien primero o elimina el servidor.'],
  ['Until you publish, your server works like Unlisted: anyone with the invite code can join.', 'Tant que vous ne publiez pas, votre serveur fonctionne comme « Non répertorié » : toute personne ayant le code d’invitation peut rejoindre.', 'Hasta que publiques, tu servidor funciona como «No listado»: cualquiera con el código de invitación puede unirse.'],
  ['Sidebars, borders, hover and text colours are generated from these two colours, so text stays readable.', 'Les barres latérales, bordures, survols et couleurs de texte sont générés à partir de ces deux couleurs, pour que le texte reste lisible.', 'Las barras laterales, bordes, resaltados y colores de texto se generan a partir de estos dos colores, para que el texto siga siendo legible.'],
  ['Nobody yet. Add the usernames of people allowed to join. People already in the server stay in.', 'Personne pour l’instant. Ajoutez les noms d’utilisateur des personnes autorisées. Les membres actuels restent.', 'Nadie todavía. Añade los nombres de usuario de quienes pueden unirse. Quienes ya están en el servidor se quedan.'],
  ['They still need your invite code or a direct invite to get in. Anyone not on this list is turned away.', 'Ils ont toujours besoin de votre code d’invitation ou d’une invitation directe. Les autres sont refusés.', 'Siguen necesitando tu código de invitación o una invitación directa. Quien no esté en la lista es rechazado.'],
  // server notifications, roles, rules, onboarding
  ['Do not alert me for announcements', 'Ne pas m’alerter pour les annonces', 'No avisarme de los anuncios'], ['Ignore @everyone', 'Ignorer @everyone', 'Ignorar @everyone'], ['MUTE SERVER', 'METTRE EN SOURDINE', 'SILENCIAR SERVIDOR'],
  ['Muted with the server', 'En sourdine avec le serveur', 'Silenciado con el servidor'], ['NOTIFY ME FOR', 'ME NOTIFIER POUR', 'NOTIFICARME DE'],
  ['A message that pings everyone is then just an ordinary message to you.', 'Un message qui mentionne tout le monde devient alors un message ordinaire pour vous.', 'Un mensaje que avisa a todos es entonces un mensaje normal para ti.'],
  ['A channel\'s own setting beats the server\'s. Right-click a channel in the list to come straight here.', 'Le réglage propre à un salon prime sur celui du serveur. Faites un clic droit sur un salon pour arriver directement ici.', 'El ajuste propio de un canal prevalece sobre el del servidor. Haz clic derecho en un canal para venir directo aquí.'],
  ['They are still counted as unread in the announcements channel.', 'Ils restent comptés comme non lus dans le salon des annonces.', 'Se siguen contando como no leídos en el canal de anuncios.'],
  ['Create role', 'Créer un rôle', 'Crear rol'], ['Custom colour', 'Couleur personnalisée', 'Color personalizado'], ['Delete role', 'Supprimer le rôle', 'Eliminar rol'], ['Kick member', 'Expulser le membre', 'Expulsar miembro'],
  ['No colour', 'Aucune couleur', 'Sin color'], ['No members match.', 'Aucun membre ne correspond.', 'Ningún miembro coincide.'], ['Pick a role to edit it, or create a new one.', 'Choisissez un rôle à modifier ou créez-en un nouveau.', 'Elige un rol para editarlo o crea uno nuevo.'],
  ['ROLE NAME', 'NOM DU RÔLE', 'NOMBRE DEL ROL'], ['Search members…', 'Rechercher des membres…', 'Buscar miembros…'], ['Everyone in the server has these, whatever their roles.', 'Tout le monde sur le serveur a ceux-ci, quels que soient ses rôles.', 'Todos en el servidor los tienen, sea cual sea su rol.'],
  ['No roles yet. Create one in the Roles tab.', 'Aucun rôle pour l’instant. Créez-en un dans l’onglet Rôles.', 'Aún no hay roles. Crea uno en la pestaña Roles.'], ['This role is at or above your own, so you can only look at it.', 'Ce rôle est égal ou supérieur au vôtre : vous pouvez seulement le consulter.', 'Este rol es igual o superior al tuyo, así que solo puedes verlo.'],
  ['Add rule', 'Ajouter une règle', 'Añadir regla'], ['Delete rule', 'Supprimer la règle', 'Eliminar regla'], ['Edit rule', 'Modifier la règle', 'Editar regla'], ['Write a rule', 'Écrire une règle', 'Escribe una regla'],
  ['Add answer', 'Ajouter une réponse', 'Añadir respuesta'], ['Add question', 'Ajouter une question', 'Añadir pregunta'], ['Allow several answers', 'Autoriser plusieurs réponses', 'Permitir varias respuestas'], ['Answer', 'Réponse', 'Respuesta'],
  ['Delete question', 'Supprimer la question', 'Eliminar pregunta'], ['Make it required for new members', 'Obligatoire pour les nouveaux membres', 'Hacerlo obligatorio para nuevos miembros'], ['Move question down', 'Descendre la question', 'Bajar la pregunta'], ['Move question up', 'Monter la question', 'Subir la pregunta'],
  ['Must answer', 'Réponse obligatoire', 'Respuesta obligatoria'], ['Remove answer', 'Retirer la réponse', 'Quitar respuesta'], ['Roles this answer gives', 'Rôles donnés par cette réponse', 'Roles que da esta respuesta'], ['Start', 'Commencer', 'Empezar'],
  ['Turn onboarding on', 'Activer l’accueil', 'Activar la bienvenida'], ['WELCOME MESSAGE', 'MESSAGE DE BIENVENUE', 'MENSAJE DE BIENVENIDA'], ['Welcome message', 'Message de bienvenue', 'Mensaje de bienvenida'],
  ['Welcome! Tell us a bit about yourself.', 'Bienvenue ! Parlez-nous un peu de vous.', '¡Bienvenido! Cuéntanos un poco sobre ti.'], ['Question, for example: What are you into?', 'Question, par exemple : Qu’est-ce qui vous passionne ?', 'Pregunta, por ejemplo: ¿Qué te gusta?'],
  // polls
  ['Add an answer', 'Ajouter une réponse', 'Añadir una respuesta'], ['Allow picking more than one answer', 'Autoriser plusieurs choix', 'Permitir elegir más de una respuesta'], ['Create a poll', 'Créer un sondage', 'Crear una encuesta'],
  ['End poll', 'Terminer le sondage', 'Terminar encuesta'], ['Every answer must be different.', 'Chaque réponse doit être différente.', 'Cada respuesta debe ser distinta.'], ['What should we play tonight?', 'À quoi joue-t-on ce soir ?', '¿A qué jugamos esta noche?'], ['· time is up', '· temps écoulé', '· se acabó el tiempo'],
  // badges, themes
  ['Badge name', 'Nom du badge', 'Nombre de la insignia'], ['Creator', 'Créateur', 'Creador'], ['Give', 'Donner', 'Dar'], ['Give to username', 'Donner à (nom d’utilisateur)', 'Dar a (nombre de usuario)'], ['New badge', 'Nouveau badge', 'Nueva insignia'],
  ['No badges yet.', 'Aucun badge pour l’instant.', 'Aún no hay insignias.'], ['Nobody has this badge yet.', 'Personne n’a encore ce badge.', 'Nadie tiene esta insignia todavía.'], ['Remove picture', 'Retirer l’image', 'Quitar imagen'], ['Take the badge back', 'Reprendre le badge', 'Quitar la insignia'],
  ['Could not load themes.', 'Impossible de charger les thèmes.', 'No se pudieron cargar los temas.'], ['Loading themes…', 'Chargement des thèmes…', 'Cargando temas…'], ['Most used', 'Les plus utilisés', 'Más usados'], ['My published themes', 'Mes thèmes publiés', 'Mis temas publicados'],
  ['Newest', 'Plus récents', 'Más recientes'], ['Publish this theme', 'Publier ce thème', 'Publicar este tema'], ['Report this theme', 'Signaler ce thème', 'Denunciar este tema'], ['Search themes', 'Rechercher des thèmes', 'Buscar temas'],
  ['Search themes or authors', 'Rechercher des thèmes ou des auteurs', 'Buscar temas o autores'], ['Show more', 'Voir plus', 'Ver más'], ['Sort', 'Trier', 'Ordenar'], ['Light and dark', 'Clair et sombre', 'Claro y oscuro'], ['Light or dark', 'Clair ou sombre', 'Claro u oscuro'],
  ['Delete this theme from the gallery', 'Supprimer ce thème de la galerie', 'Eliminar este tema de la galería'],
  // bots
  ['ADD A BOT', 'AJOUTER UN BOT', 'AÑADIR UN BOT'], ['All bots', 'Tous les bots', 'Todos los bots'], ['Bot code', 'Code du bot', 'Código del bot'], ['Bot description', 'Description du bot', 'Descripción del bot'], ['Bot name', 'Nom du bot', 'Nombre del bot'], ['Bot tags', 'Tags du bot', 'Etiquetas del bot'],
  ['Delete bot', 'Supprimer le bot', 'Eliminar bot'], ['New bot', 'Nouveau bot', 'Nuevo bot'], ['No bots yet.', 'Aucun bot pour l’instant.', 'Aún no hay bots.'], ['Recent runs', 'Exécutions récentes', 'Ejecuciones recientes'], ['Search bots to add', 'Rechercher des bots à ajouter', 'Buscar bots para añadir'],
  ['Search public bots and your own', 'Rechercher parmi les bots publics et les vôtres', 'Buscar bots públicos y los tuyos'], ['Test message', 'Message de test', 'Mensaje de prueba'], ['This is a bot', 'Ceci est un bot', 'Esto es un bot'], ['Try it', 'Essayer', 'Probar'], ['WHO CAN ADD IT', 'QUI PEUT L’AJOUTER', 'QUIÉN PUEDE AÑADIRLO'],
  ['What your code can use', 'Ce que votre code peut utiliser', 'Lo que puede usar tu código'], ['You have no bots yet.', 'Vous n’avez pas encore de bot.', 'Todavía no tienes bots.'], ['Already added', 'Déjà ajouté', 'Ya añadido'], ['Message text', 'Texte du message', 'Texto del mensaje'],
  ['What does your bot do? Public bots need this.', 'Que fait votre bot ? Les bots publics en ont besoin.', '¿Qué hace tu bot? Los bots públicos lo necesitan.'], ['The bot did not do anything.', 'Le bot n’a rien fait.', 'El bot no hizo nada.'],
  ['You do not manage any server. You need the Manage server permission to add a bot.', 'Vous ne gérez aucun serveur. Il faut la permission « Gérer le serveur » pour ajouter un bot.', 'No administras ningún servidor. Necesitas el permiso «Administrar servidor» para añadir un bot.'],
  ['You have reached the limit. Delete a bot to make a new one.', 'Limite atteinte. Supprimez un bot pour en créer un nouveau.', 'Has llegado al límite. Elimina un bot para crear otro.'],
  ['Nothing has run yet. Add the bot to a server and send a message.', 'Rien ne s’est encore exécuté. Ajoutez le bot à un serveur et envoyez un message.', 'Todavía no se ha ejecutado nada. Añade el bot a un servidor y envía un mensaje.'],
  ['A server can have up to 10 bots.', 'Un serveur peut avoir jusqu’à 10 bots.', 'Un servidor puede tener hasta 10 bots.'], ['Bots never receive messages from other bots.', 'Les bots ne reçoivent jamais les messages d’autres bots.', 'Los bots nunca reciben mensajes de otros bots.'],
];

const LANG_COL = { fr: 1, es: 2 };
const norm = (s) => s.replace(/\s+/g, ' ');
const MAP = new Map();
for (const row of BOOK) MAP.set(norm(row[0]), row);

// the translation of one piece of text (keeping the spaces around it), or the text itself
function lookup(en, lang) {
  const col = LANG_COL[lang];
  if (!col) return en;
  const m = en.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const row = m[2] && MAP.get(norm(m[2]));
  return row ? m[1] + row[col] + m[3] : en;
}

const SKIP = 'script,style,textarea,input,code,pre,.content,[translate="no"]'; // people's own messages and code are left alone
const ATTRS = ['placeholder', 'title', 'aria-label'];
const texts = new WeakMap(); // text node -> { en, out }
const attrs = new WeakMap(); // element -> { attr: { en, out } }

function doText(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIP)) return;
  const v = node.nodeValue, rec = texts.get(node);
  const en = rec && v === rec.out ? rec.en : v; // if React wrote new text, that is the new English
  const out = lookup(en, getLang());
  if (out !== v) node.nodeValue = out;
  if (out !== en || rec) texts.set(node, { en, out });
}

function doAttr(el, name) {
  if (el.closest && el.closest(SKIP)) return;
  const v = el.getAttribute(name);
  if (v == null) return;
  const all = attrs.get(el) || {}, rec = all[name];
  const en = rec && v === rec.out ? rec.en : v;
  const out = lookup(en, getLang());
  if (out !== v) el.setAttribute(name, out);
  if (out !== en || rec) { all[name] = { en, out }; attrs.set(el, all); }
}

function walk(root) {
  if (root.nodeType === 3) return doText(root);
  if (root.nodeType !== 1) return;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) doText(n);
  const els = [root, ...root.querySelectorAll('[placeholder],[title],[aria-label]')];
  for (const el of els) for (const a of ATTRS) if (el.hasAttribute && el.hasAttribute(a)) doAttr(el, a);
}

export function startPhrases() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(walk);
      else if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttr(m.target, m.attributeName);
    }
  });
  const go = () => {
    obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    walk(document.body);
  };
  if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
  onLang(() => walk(document.body)); // switching language redoes everything on screen (and puts English back for English)
}
