import { pickWbOverflowShipment } from '../src/services/shipments.service.js';

describe('pickWbOverflowShipment', () => {
  const main = {
    id: 'ship-main',
    marketplace: 'wildberries',
    closed: false,
    profileId: 1,
    organizationId: '10',
    createdAt: '2026-07-27T10:31:00.000Z',
    orderIds: Array.from({ length: 27 }, (_, i) => String(1000 + i)),
  };
  const overflowA = {
    id: 'ship-overflow-a',
    marketplace: 'wildberries',
    closed: false,
    profileId: 1,
    organizationId: '10',
    createdAt: '2026-07-27T11:18:00.000Z',
    orderIds: ['2001'],
    externalId: 'WB-GI-259029409',
  };
  const overflowB = {
    id: 'ship-overflow-b',
    marketplace: 'wildberries',
    closed: false,
    profileId: 1,
    organizationId: '10',
    createdAt: '2026-07-27T11:39:00.000Z',
    orderIds: ['2002'],
    externalId: 'WB-GI-259035604',
  };

  test('first relocate from main creates no pick (caller creates) when only main exists', () => {
    expect(pickWbOverflowShipment([main], main, { profileId: 1, organizationId: '10' })).toBeNull();
  });

  test('second relocate from main reuses existing overflow instead of needing a third GI', () => {
    const picked = pickWbOverflowShipment([main, overflowA], main, {
      profileId: 1,
      organizationId: '10',
    });
    expect(picked?.id).toBe('ship-overflow-a');
  });

  test('prefers smaller overflow when several open WB supplies exist', () => {
    const picked = pickWbOverflowShipment([main, overflowA, overflowB], main, {
      profileId: 1,
      organizationId: '10',
    });
    expect(picked?.id).toBe('ship-overflow-a');
  });

  test('prefers smaller non-empty overflow over empty leftover GI', () => {
    const emptyLeftover = {
      id: 'ship-empty',
      marketplace: 'wildberries',
      closed: false,
      profileId: 1,
      organizationId: '10',
      createdAt: '2026-07-27T11:40:00.000Z',
      orderIds: [],
      externalId: 'WB-GI-EMPTY',
    };
    const picked = pickWbOverflowShipment([main, overflowA, emptyLeftover], main, {
      profileId: 1,
      organizationId: '10',
    });
    expect(picked?.id).toBe('ship-overflow-a');
  });

  test('ignores closed and other profile/org', () => {
    const closed = { ...overflowA, id: 'ship-closed', closed: true };
    const otherOrg = { ...overflowA, id: 'ship-other-org', organizationId: '99' };
    const otherProfile = { ...overflowA, id: 'ship-other-prof', profileId: 2 };
    const picked = pickWbOverflowShipment([main, closed, otherOrg, otherProfile, overflowB], main, {
      profileId: 1,
      organizationId: '10',
    });
    expect(picked?.id).toBe('ship-overflow-b');
  });
});
