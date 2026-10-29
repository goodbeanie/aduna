// Game detection for the desktop app (no Electron, no network: tested by games-test.js).
//
// Like Discord's "Playing ...": the app looks at the names of the programs that are running, and only if one of them is on the
// fixed list below does it say which game it is. Nothing else about the computer is read or sent: not the window titles, not
// the other programs, not the files. A program that is not on the list is simply never mentioned.

// program name (lowercase) -> the name shown on the profile
const GAMES = {
  'cs2.exe': 'Counter-Strike 2',
  'valorant-win64-shipping.exe': 'VALORANT',
  'league of legends.exe': 'League of Legends',
  'dota2.exe': 'Dota 2',
  'fortniteclient-win64-shipping.exe': 'Fortnite',
  'minecraft.windows.exe': 'Minecraft',
  'robloxplayerbeta.exe': 'Roblox',
  'gta5.exe': 'Grand Theft Auto V',
  'rocketleague.exe': 'Rocket League',
  'r5apex.exe': 'Apex Legends',
  'r5apex_dx12.exe': 'Apex Legends',
  'overwatch.exe': 'Overwatch 2',
  'tslgame.exe': 'PUBG: BATTLEGROUNDS',
  'rainbowsix.exe': 'Rainbow Six Siege',
  'rainbowsix_vulkan.exe': 'Rainbow Six Siege',
  'cyberpunk2077.exe': 'Cyberpunk 2077',
  'eldenring.exe': 'ELDEN RING',
  'sekiro.exe': 'Sekiro',
  'darksoulsiii.exe': 'DARK SOULS III',
  'terraria.exe': 'Terraria',
  'stardew valley.exe': 'Stardew Valley',
  'rustclient.exe': 'Rust',
  'among us.exe': 'Among Us',
  'hollow_knight.exe': 'Hollow Knight',
  'palworld-win64-shipping.exe': 'Palworld',
  'fallguys_client_game.exe': 'Fall Guys',
  'destiny2.exe': 'Destiny 2',
  'warframe.x64.exe': 'Warframe',
  'wow.exe': 'World of Warcraft',
  'wow-64.exe': 'World of Warcraft',
  'diablo iv.exe': 'Diablo IV',
  'hearthstone.exe': 'Hearthstone',
  'genshinimpact.exe': 'Genshin Impact',
  'starrail.exe': 'Honkai: Star Rail',
  'zenlesszonezero.exe': 'Zenless Zone Zero',
  'cities.exe': 'Cities: Skylines',
  'rdr2.exe': 'Red Dead Redemption 2',
  'witcher3.exe': 'The Witcher 3',
  'bg3.exe': 'Baldur’s Gate 3',
  'bg3_dx11.exe': 'Baldur’s Gate 3',
  'helldivers2.exe': 'HELLDIVERS 2',
  'lethal company.exe': 'Lethal Company',
  'phasmophobia.exe': 'Phasmophobia',
  'left4dead2.exe': 'Left 4 Dead 2',
  'eurotrucks2.exe': 'Euro Truck Simulator 2',
  'factorygame-win64-shipping.exe': 'Satisfactory',
  'forzahorizon5.exe': 'Forza Horizon 5',
  'fc24.exe': 'EA SPORTS FC 24',
  'fc25.exe': 'EA SPORTS FC 25',
  'subnautica.exe': 'Subnautica',
  'valheim.exe': 'Valheim',
  'deadbydaylight-win64-shipping.exe': 'Dead by Daylight',
  'brawlhalla.exe': 'Brawlhalla',
  'sonsoftheforest.exe': 'Sons Of The Forest',
  'content warning.exe': 'Content Warning',
  'readyornotsteam-win64-shipping.exe': 'Ready or Not',
  'marvel-win64-shipping.exe': 'Marvel Rivals',
  'project8.exe': 'Deadlock',
  'osu!.exe': 'osu!',
  'celeste.exe': 'Celeste',
  'undertale.exe': 'Undertale',
  'cuphead.exe': 'Cuphead',
  'factorio.exe': 'Factorio',
  'rimworldwin64.exe': 'RimWorld',
  'projectzomboid64.exe': 'Project Zomboid',
  'civilizationvi.exe': 'Sid Meier’s Civilization VI',
  'sc2_x64.exe': 'StarCraft II',
  'tf_win64.exe': 'Team Fortress 2',
  'gmod.exe': 'Garry’s Mod',
  'fallout4.exe': 'Fallout 4',
  'skyrimse.exe': 'The Elder Scrolls V: Skyrim',
  'starfield.exe': 'Starfield',
  'hogwartslegacy.exe': 'Hogwarts Legacy',
  'monsterhunterworld.exe': 'Monster Hunter: World',
  'monsterhunterwilds.exe': 'Monster Hunter Wilds',
  'blackdesert64.exe': 'Black Desert',
  'escapefromtarkov.exe': 'Escape from Tarkov',
  'pathofexile.exe': 'Path of Exile',
  'pathofexile_x64.exe': 'Path of Exile',
  'lostark.exe': 'Lost Ark',
  'newworld.exe': 'New World',
  'albion-online.exe': 'Albion Online',
  'huntgame.exe': 'Hunt: Showdown',
  'bf2042.exe': 'Battlefield 2042',
  'cod.exe': 'Call of Duty',
  'haloinfinite.exe': 'Halo Infinite',
  'sotgame.exe': 'Sea of Thieves',
  'overcooked2.exe': 'Overcooked! 2',
  'ittakestwo.exe': 'It Takes Two',
  '7daystodie.exe': '7 Days to Die',
  'theforest.exe': 'The Forest',
  'geometrydash.exe': 'Geometry Dash',
  'vampiresurvivors.exe': 'Vampire Survivors',
  'balatro.exe': 'Balatro',
  'hades2.exe': 'Hades II',
};

// "tasklist /fo csv /nh" prints one line per program: "chrome.exe","1234","Console","1","100,000 K". Returns the program names, lowercase.
function parseTasklist(text) {
  const names = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

// Which game to report. `running` is a Set of lowercase program names; `prev` is the game reported last time.
// If that one is still running it stays (so two games open at once do not flip back and forth); otherwise the first one found.
function pick(running, prev) {
  const found = [];
  for (const exe of running) { const g = GAMES[exe]; if (g && !found.includes(g)) found.push(g); }
  if (!found.length) return null;
  return prev && found.includes(prev) ? prev : found.sort()[0];
}

module.exports = { GAMES, parseTasklist, pick };
