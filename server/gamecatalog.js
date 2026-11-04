// The game list behind the profile "Favorite games" picker. Like profile.js this has no Express / database imports.
//
// Each entry is [name, steamAppId]. The Steam app id is what gives the game its picture: the client builds
// https://cdn.cloudflare.steamstatic.com/steam/apps/<id>/library_600x900.jpg (falling back to header.jpg) from it.
// 0 means "not on Steam" (Minecraft, Fortnite, Nintendo games ...): the picker draws a lettered tile for those.
// Anything that is not in this list can still be found through /api/games/search (Steam's store search), or typed by hand.
//
// Adding a game is one line here. Keep a name to 40 characters or less (LIMITS.gameName in profile.js).

const CATALOG = [
  // shooters and team games
  ['Counter-Strike 2', 730], ['Counter-Strike: Source', 240], ['Team Fortress 2', 440], ['Left 4 Dead 2', 550], ['Left 4 Dead', 500],
  ['Half-Life', 70], ['Half-Life 2', 220], ['Half-Life: Alyx', 546560], ['Portal', 400], ['Portal 2', 620],
  ['Dota 2', 570], ['PUBG: BATTLEGROUNDS', 578080], ['Apex Legends', 1172470], ['Rust', 252490], ['Rainbow Six Siege', 359550],
  ['Overwatch 2', 2357570], ['Marvel Rivals', 2767030], ['Destiny 2', 1085660], ['Warframe', 230410], ['Call of Duty', 1938090],
  ['Battlefield 1', 1238840], ['Battlefield 4', 1238860], ['Battlefield 2042', 1517290],
  ['Halo: The Master Chief Collection', 976730], ['Halo Infinite', 1240440],
  ['Borderlands 2', 49520], ['Borderlands 3', 397540], ['Tiny Tina\u2019s Wonderlands', 1286680],
  ['PAYDAY 2', 218620], ['PAYDAY 3', 1272080], ['Killing Floor 2', 232090], ['Deep Rock Galactic', 548430], ['Helldivers 2', 553850],
  ['THE FINALS', 2073850], ['Hunt: Showdown', 594650], ['Delta Force', 2507950], ['Deadlock', 1422450], ['Back 4 Blood', 924970],
  ['World War Z', 699130], ['Squad', 393380], ['Arma 3', 107410], ['DayZ', 221100], ['Insurgency: Sandstorm', 581320],
  ['Ready or Not', 1144200], ['Hell Let Loose', 686810], ['War Thunder', 236390], ['World of Warships', 552990],
  ['Garry\u2019s Mod', 4000], ['Brawlhalla', 291550], ['Rocket League', 252950], ['Fall Guys', 1097150], ['Smite', 386360], ['Paladins', 444090],
  ['Naraka: Bladepoint', 1203220], ['Once Human', 2139460], ['Warhammer 40,000: Darktide', 1361210], ['Warhammer: Vermintide 2', 552500],
  ['Valorant', 0], ['Fortnite', 0], ['League of Legends', 0], ['Escape from Tarkov', 0], ['Overwatch', 0], ['Hearthstone', 0],

  // party and co-op
  ['Among Us', 945360], ['Phasmophobia', 739630], ['Lethal Company', 1966720], ['Content Warning', 2881650], ['R.E.P.O.', 3241660],
  ['PEAK', 3527290], ['Schedule I', 3164500], ['Dead by Daylight', 381210], ['Sea of Thieves', 1172620], ['Valheim', 892970],
  ['Palworld', 1623730], ['It Takes Two', 1426210], ['A Way Out', 1222700], ['Overcooked! 2', 728880], ['Human: Fall Flat', 477160],
  ['Gang Beasts', 285900], ['Ultimate Chicken Horse', 386940], ['Golf With Your Friends', 431240], ['Pummel Party', 880940],
  ['PlateUp!', 1599600], ['Stumble Guys', 0], ['Pok\u00e9mon GO', 0], ['Mario Kart 8 Deluxe', 0], ['Super Smash Bros. Ultimate', 0],

  // survival and building
  ['Terraria', 105600], ['Stardew Valley', 413150], ['Don\u2019t Starve Together', 322330], ['Project Zomboid', 108600], ['7 Days to Die', 251570],
  ['ARK: Survival Evolved', 346110], ['Raft', 648800], ['The Forest', 242760], ['Sons of the Forest', 1326470], ['Subnautica', 264710],
  ['Subnautica: Below Zero', 848450], ['No Man\u2019s Sky', 275850], ['Satisfactory', 526870], ['Factorio', 427520], ['RimWorld', 294100],
  ['Oxygen Not Included', 457140], ['Grounded', 962130], ['Green Hell', 815370], ['The Long Dark', 305620], ['Space Engineers', 244850],
  ['Stormworks', 573090], ['Teardown', 1167630], ['Minecraft', 0], ['Roblox', 0], ['Animal Crossing: New Horizons', 0],

  // strategy and sim
  ['Cities: Skylines', 255710], ['Civilization VI', 289070], ['Civilization V', 8930], ['Stellaris', 281990], ['Hearts of Iron IV', 394360],
  ['Europa Universalis IV', 236850], ['Crusader Kings III', 1158310], ['Age of Empires II: Definitive Edition', 813780],
  ['Total War: Warhammer III', 1142710], ['Total War: Three Kingdoms', 779340], ['XCOM 2', 268500], ['Mount & Blade II: Bannerlord', 261550],
  ['Kerbal Space Program', 220200], ['Tropico 6', 492720], ['Frostpunk', 323190], ['This War of Mine', 282070], ['Northgard', 466560],
  ['Against the Storm', 1336490], ['Manor Lords', 1363080], ['Bloons TD 6', 960090], ['Plants vs. Zombies GOTY', 3590],
  ['The Sims 4', 1222670], ['Planet Zoo', 703080], ['Planet Coaster', 493340], ['Jurassic World Evolution 2', 1244460],
  ['Two Point Hospital', 535930], ['House Flipper', 613100], ['PowerWash Simulator', 1290000], ['Cooking Simulator', 641990],
  ['Euro Truck Simulator 2', 227300], ['American Truck Simulator', 270880], ['Microsoft Flight Simulator (2020)', 1250410],
  ['Microsoft Flight Simulator 2024', 2537590], ['Elite Dangerous', 359320], ['Star Citizen', 0],

  // racing and sports
  ['BeamNG.drive', 284160], ['Assetto Corsa', 244210], ['Forza Horizon 5', 1551360], ['Forza Horizon 4', 1293830], ['Need for Speed Heat', 1222680],
  ['TrackMania', 2225070], ['Wreckfest', 228380], ['DiRT Rally 2.0', 690790], ['F1 24', 2488620], ['Football Manager 2024', 2252570],
  ['EA SPORTS FC 25', 2669320], ['EA SPORTS FC 24', 2195250], ['NBA 2K25', 2878980],

  // fighting
  ['Tekken 8', 1778820], ['Street Fighter 6', 1364780], ['Mortal Kombat 1', 1971870], ['Mortal Kombat 11', 976310],
  ['Guilty Gear -Strive-', 1384160], ['DRAGON BALL FighterZ', 678950],

  // action RPG and open world
  ['Elden Ring', 1245620], ['Dark Souls III', 374320], ['Dark Souls Remastered', 570940], ['Sekiro: Shadows Die Twice', 814380],
  ['Black Myth: Wukong', 2358720], ['Lies of P', 1627720], ['Armored Core VI', 1888160], ['Sifu', 2138710],
  ['Baldur\u2019s Gate 3', 1086940], ['Cyberpunk 2077', 1091500], ['The Witcher 3: Wild Hunt', 292030], ['Skyrim Special Edition', 489830],
  ['Fallout 4', 377160], ['Fallout: New Vegas', 22380], ['Fallout 76', 1151340], ['Starfield', 1716740], ['Oblivion Remastered', 2623190],
  ['Mass Effect Legendary Edition', 1328670], ['Dragon Age: Inquisition', 1222690], ['Red Dead Redemption 2', 1174180],
  ['Grand Theft Auto V', 271590], ['Hogwarts Legacy', 990080], ['Monster Hunter: World', 582010], ['Monster Hunter Wilds', 2246340],
  ['Monster Hunter Rise', 1446780], ['Persona 5 Royal', 1687950], ['Final Fantasy XIV', 39210], ['Final Fantasy VII Remake', 1462040],
  ['Final Fantasy XVI', 2515020], ['Remnant II', 1282100], ['Metro Exodus', 412020], ['S.T.A.L.K.E.R. 2', 1643320], ['Control', 870780],
  ['Death Stranding', 1190460], ['God of War', 1593500], ['God of War Ragnar\u00f6k', 2322010], ['Marvel\u2019s Spider-Man Remastered', 1817070],
  ['Horizon Zero Dawn', 1151640], ['The Last of Us Part I', 1888930], ['Ghost of Tsushima', 2215430], ['Zelda: Breath of the Wild', 0],
  ['Genshin Impact', 0], ['Honkai: Star Rail', 0], ['Zenless Zone Zero', 0], ['Wuthering Waves', 0],

  // MMOs and online RPGs
  ['Path of Exile', 238960], ['Path of Exile 2', 2694490], ['Diablo IV', 2344520], ['Lost Ark', 1599340], ['New World', 1063730],
  ['Guild Wars 2', 1284210], ['Black Desert', 582660], ['RuneScape', 1343400], ['Albion Online', 761890], ['The Elder Scrolls Online', 306130],
  ['THRONE AND LIBERTY', 2429640], ['World of Warcraft', 0], ['Old School RuneScape', 0],

  // indie and roguelike
  ['Hades', 1145360], ['Hades II', 1145350], ['Hollow Knight', 367520], ['Hollow Knight: Silksong', 1030300], ['Celeste', 504230],
  ['Cuphead', 268910], ['Undertale', 391540], ['Slay the Spire', 646570], ['Balatro', 2379780], ['Vampire Survivors', 1794680],
  ['Dave the Diver', 1868140], ['Cult of the Lamb', 1313140], ['Hi-Fi RUSH', 1817230], ['Disco Elysium', 632470],
  ['Geometry Dash', 322170], ['SUPERHOT', 322500], ['Hotline Miami', 219150], ['Risk of Rain 2', 632360], ['Enter the Gungeon', 311690],
  ['The Binding of Isaac: Rebirth', 250900], ['Dead Cells', 588650], ['Spelunky 2', 418530], ['Ori and the Will of the Wisps', 1057090],
  ['LIMBO', 48000], ['INSIDE', 304430], ['Little Nightmares II', 860510], ['Outer Wilds', 753640], ['Firewatch', 383870],
  ['The Stanley Parable: Ultra Deluxe', 1703340], ['Stray', 1332010], ['Unpacking', 1135690], ['Untitled Goose Game', 837470],
  ['Noita', 881100], ['Loop Hero', 1282730], ['Wizard of Legend', 445980], ['Monster Train', 1102190], ['Inscryption', 1092790],
  ['Against the Storm', 1336490], ['Beat Saber', 620980], ['Tetris Effect: Connected', 1003590], ['Doki Doki Literature Club', 698780],
  ['Bloons TD 6', 960090], ['osu!', 0], ['Chess', 0], ['Wordle', 0],

  // horror
  ['Resident Evil 4', 2050650], ['Resident Evil Village', 1196590], ['Resident Evil 2', 883710], ['Outlast', 238320], ['Amnesia: The Bunker', 1944430],
  ['Dead Space', 1693980], ['Alien: Isolation', 214490], ['Five Nights at Freddy\u2019s', 319510], ['FNaF: Security Breach', 747660],
  ['Poppy Playtime', 1721470], ['Dying Light', 239140], ['Dying Light 2', 534380], ['Silent Hill 2', 2124490],
];

// one entry per name (a name listed twice keeps its first line), sorted for the picker
const seen = new Set();
const LIST = [];
for (const [name, app] of CATALOG) {
  const k = name.toLowerCase();
  if (seen.has(k)) continue;
  seen.add(k);
  LIST.push({ name, app });
}
LIST.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

const BY_NAME = new Map(LIST.map((g) => [g.name.toLowerCase(), g]));
// the Steam app id for a game name from the list (0 when it is not in the list or not on Steam)
const appFor = (name) => (BY_NAME.get(String(name || '').trim().toLowerCase()) || { app: 0 }).app;

module.exports = { LIST, appFor };
