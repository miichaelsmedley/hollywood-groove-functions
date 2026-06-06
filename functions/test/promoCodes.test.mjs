import test from "node:test";
import assert from "node:assert/strict";
import shared from "../lib/ticketing/shared.js";

const { calculatePromoDiscount, normalisePromoCode } = shared;

test("normalises promo codes for Firestore ids", () => {
  assert.equal(normalisePromoCode(" early bird "), "EARLYBIRD");
  assert.equal(normalisePromoCode("VIP-20"), "VIP-20");
  assert.equal(normalisePromoCode("x"), null);
});

test("calculates percent promo against ticket subtotal only", () => {
  const result = calculatePromoDiscount({
    promoCodeId: "EARLYBIRD",
    promo: {
      code: "EARLYBIRD",
      active: true,
      discountType: "percent",
      percentOff: 25,
    },
    quantity: 2,
    ticketTypeId: "ga",
    subtotalCents: 7800,
  });

  assert.equal(result.discountCents, 1950);
  assert.equal(result.subtotalAfterDiscountCents, 5850);
});

test("caps fixed amount promo at ticket subtotal", () => {
  const result = calculatePromoDiscount({
    promoCodeId: "FREEISH",
    promo: {
      code: "FREEISH",
      active: true,
      discountType: "amount",
      amountOffCents: 10000,
    },
    quantity: 1,
    ticketTypeId: "ga",
    subtotalCents: 3900,
  });

  assert.equal(result.discountCents, 3900);
  assert.equal(result.subtotalAfterDiscountCents, 0);
});

test("rejects expired promo codes", () => {
  assert.throws(
    () =>
      calculatePromoDiscount({
        promoCodeId: "OLD",
        promo: {
          code: "OLD",
          active: true,
          discountType: "percent",
          percentOff: 10,
          validUntil: Date.now() - 1000,
        },
        quantity: 1,
        ticketTypeId: "ga",
        subtotalCents: 3900,
      }),
    /expired/,
  );
});
