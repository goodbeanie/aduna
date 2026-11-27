import React from 'react';

// Chess pieces for the chess puzzle. Each one is drawn in the pixel space of the source icon sheet (stroke 12, bottom edge at y 234) and
// scaled into the 100 x 100 box. .f is a filled outline, .l an open line, .d a solid dot. Colours are in puzzle.css.
const PIECES = {
  p: { cx: 131, parts: <>
    <circle className="f" cx="131" cy="115" r="31" />
    <path className="f" d="M120 170 L142 170 Q149 170 151 176 L172 234 L90 234 L111 176 Q113 170 120 170 Z" />
  </> },
  r: { cx: 392, parts: <>
    <path className="f" d="M347 83 L436 83 L421 134 Q420 137 417 137 L366 137 Q363 137 362 134 Z" />
    <path className="l" d="M391 86 L391 102" />
    <path className="f" d="M360 160 L424 160 Q430 160 432 166 L454 234 L330 234 L352 166 Q354 160 360 160 Z" />
  </> },
  n: { cx: 654, parts: <>
    <path className="f" d="M607 153 L607 134 Q607 127 612 122 L645 91 Q650 83 659 83 L675 83 Q681 83 681 89 L681 147 Q681 153 675 153 Z" />
    <path className="l" d="M681 128 L648 153" />
    <circle className="d" cx="636" cy="119" r="7" />
    <path className="f" d="M635 177 L674 177 Q680 177 682 183 L702 234 L606 234 L626 183 Q628 177 635 177 Z" />
  </> },
  b: { cx: 914, parts: <>
    <path className="f" d="M914 66 C890 85 882 108 882 128 C882 143 896 154 914 154 C932 154 946 143 946 130 C946 110 935 85 914 66 Z" />
    <path className="l" d="M914 119 L934 122 Q939 123 939 129" />
    <path className="f" d="M893 177 L935 177 Q941 177 943 183 L962 234 L866 234 L885 183 Q887 177 893 177 Z" />
  </> },
  q: { cx: 1176, parts: <>
    <circle className="d" cx="1130" cy="40" r="7" />
    <circle className="d" cx="1161" cy="40" r="7" />
    <circle className="d" cx="1192" cy="40" r="7" />
    <circle className="d" cx="1223" cy="40" r="7" />
    <path className="l" d="M1141 61 L1211 61" />
    <path className="f" d="M1130 83 L1222 83 L1208 133 Q1207 137 1203 137 L1149 137 Q1145 137 1144 133 Z" />
    <path className="f" d="M1155 160 L1197 160 Q1203 160 1205 166 L1224 234 L1128 234 L1147 166 Q1149 160 1155 160 Z" />
  </> },
  k: { cx: 1437, parts: <>
    <path className="l" d="M1437 27 L1437 58" />
    <path className="l" d="M1404 47 L1470 47" />
    <path className="f" d="M1420 79 L1458 79 Q1463 79 1464 84 L1482 129 Q1483 133 1479 133 L1397 133 Q1393 133 1394 129 L1411 84 Q1413 79 1420 79 Z" />
    <path className="f" d="M1400 160 L1474 160 Q1480 160 1482 166 L1499 234 L1376 234 L1393 166 Q1395 160 1400 160 Z" />
  </> },
};

export default function ChessPiece({ kind, white }) {
  const p = PIECES[kind];
  return (
    <svg className={'pz-p ' + (white ? 'w' : 'b')} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <g transform={`translate(50 93.3) scale(0.45) translate(${-p.cx} -234)`}>{p.parts}</g>
    </svg>
  );
}
