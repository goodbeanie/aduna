import React from 'react';

// Flat vector pieces for the chess puzzle, drawn on a 100 x 100 grid. Colours are in puzzle.css.
const BASE = 'M24 86H76V80Q76 76 72 76H28Q24 76 24 80Z';

const SHAPES = {
  p: <>
    <circle className="f" cx="50" cy="32" r="11" />
    <path className="f" d="M38 52Q50 46 62 52Q58 58 57 64Q70 70 72 76H28Q30 70 43 64Q42 58 38 52Z" />
  </>,
  r: <>
    <path className="f" d="M30 20H40V27H46V20H54V27H60V20H70V38H30Z" />
    <path className="f" d="M34 38H66L64 68H36Z" />
    <path className="f" d="M30 68H70V76H30Z" />
  </>,
  n: <>
    <path className="f" d="M28 76C28 60 34 52 44 44C48 40 46 38 42 40L34 46L28 42C32 32 42 24 46 18L50 22C60 18 68 26 72 38C76 50 74 66 76 76Z" />
    <circle className="e" cx="53" cy="32" r="2.6" />
  </>,
  b: <>
    <circle className="f" cx="50" cy="14" r="4.5" />
    <path className="f" d="M50 18C64 28 68 42 60 54H40C32 42 36 28 50 18Z" />
    <path className="s" d="M52 28L58 38" />
    <path className="f" d="M35 54H65V61H35Z" />
    <path className="f" d="M41 61H59L66 76H34Z" />
  </>,
  q: <>
    <path className="f" d="M28 76L20 36L34 56L35 32L44 54L50 28L56 54L65 32L66 56L80 36L72 76Z" />
    <circle className="f" cx="20" cy="32" r="4" />
    <circle className="f" cx="35" cy="27" r="4" />
    <circle className="f" cx="50" cy="23" r="4" />
    <circle className="f" cx="65" cy="27" r="4" />
    <circle className="f" cx="80" cy="32" r="4" />
  </>,
  k: <>
    <path className="f" d="M50 32C70 32 78 44 72 56C70 62 66 66 68 76H32C34 66 30 62 28 56C22 44 30 32 50 32Z" />
    <path className="f" d="M47 10H53V32H47Z" />
    <path className="f" d="M40 17H60V23H40Z" />
    <path className="s" d="M36 60H64" />
  </>,
};

export default function ChessPiece({ kind, white }) {
  return (
    <svg className={'pz-p ' + (white ? 'w' : 'b')} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      {SHAPES[kind]}
      <path className="f" d={BASE} />
    </svg>
  );
}
