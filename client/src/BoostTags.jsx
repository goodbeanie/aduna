import React from 'react';

// BOOSTED goes next to the name of a boosted server, Booster next to the person who paid for the boost (rules: server/boosts.js).
export const BoostedTag = ({ level }) => <span className="boosted-tag" title={level ? `Boosted, level ${level}` : 'Boosted'}>Boosted</span>;
export const BoosterTag = ({ level }) => <span className="booster-tag" title={level ? `Boosting this server, level ${level}` : 'Boosting this server'}>Booster</span>;
