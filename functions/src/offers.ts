import * as admin from "firebase-admin";
import { randomBytes } from "crypto";
import { onValueWritten, DataSnapshot, DatabaseEvent } from "firebase-functions/v2/database";
import { Change } from "firebase-functions/common";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { requireAuth, REQUIRE_APP_CHECK } from "./lib/requireAuth";

const REGION = "asia-southeast1";

type OfferEligibility = "set_winner" | "night_winner" | "broadcast";
type PrizeType = "free_ticket" | "venue_drink" | "custom";

type ShowOffer = {
  title?: string;
  description?: string | null;
  type?: string;
  prize_type?: PrizeType | string;
  eligibility?: OfferEligibility | string;
  active?: boolean;
  total_quantity?: number | null;
  claimed_count?: number | null;
  claim_limit_per_user?: number | null;
  custom_prize_text?: string | null;
};

type WinnerResult = {
  uid?: string | null;
  displayName?: string | null;
  points?: number | null;
  setNumber?: number | null;
  computedAt?: number | null;
  closedAt?: number | null;
  noWinner?: boolean | null;
};

type OfferClaim = {
  showId: string;
  offerId: string;
  uid: string;
  displayName: string;
  offerTitle: string;
  offerDescription: string | null;
  prizeType: PrizeType;
  eligibility: OfferEligibility;
  voucherCode: string;
  claimed_at: number;
  redeemed: boolean;
  redeemed_at: number | null;
  sourceAwardKey?: string | null;
  sourceWinnerPoints?: number | null;
};

type ClaimOfferInput = {
  showId?: unknown;
  offerId?: unknown;
  isTestShow?: unknown;
};

type RedeemOfferInput = ClaimOfferInput;

type WinnerParams = {
  showId: string;
  setNumber?: string;
};

function normalizeNamespacePrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function namespaceRoot(prefix: string): string {
  const normalized = normalizeNamespacePrefix(prefix);
  return normalized.length > 0 ? `/${normalized}` : "";
}

function showPath(root: string, showId: string, path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  return `${root}/shows/${showId}/${trimmed}`;
}

function rootPath(root: string, path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  return `${root}/${trimmed}`;
}

function stringInput(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", `${fieldName} is required.`);
  }
  return value.trim();
}

function rootFromCallableInput(value: unknown): string {
  return value === true ? "/test" : "";
}

function intOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function activeOfferEntries(
  offers: Record<string, ShowOffer>,
  eligibility: OfferEligibility,
  setNumber?: number
): Array<[string, ShowOffer]> {
  return Object.entries(offers).filter(([, offer]) => {
    if (offer.active !== true) return false;
    if (offer.eligibility !== eligibility) return false;
    const scopedSetNumber = intOrDefault((offer as Record<string, unknown>).set_number, 0);
    return eligibility !== "set_winner" || scopedSetNumber <= 0 || scopedSetNumber === setNumber;
  });
}

function prizeTypeOf(offer: ShowOffer): PrizeType {
  if (offer.prize_type === "venue_drink" || offer.prize_type === "custom") {
    return offer.prize_type;
  }
  return "free_ticket";
}

function makeVoucherCode(): string {
  return `HG-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function publicClaim(claim: OfferClaim) {
  return {
    ...claim,
    claimedAt: claim.claimed_at,
    redeemedAt: claim.redeemed_at,
  };
}

async function materializeWinnerAwards(params: {
  database: admin.database.Database;
  root: string;
  showId: string;
  winner: WinnerResult;
  eligibility: OfferEligibility;
  awardKey: string;
  setNumber?: number;
}): Promise<void> {
  const { database, root, showId, winner, eligibility, awardKey, setNumber } = params;
  if (winner.noWinner || !winner.uid) return;

  const offersSnap = await database.ref(showPath(root, showId, "offers")).get();
  const offers = (offersSnap.val() as Record<string, ShowOffer> | null) ?? {};
  const matchingOffers = activeOfferEntries(offers, eligibility, setNumber);
  if (matchingOffers.length === 0) return;

  const awardedAt = intOrDefault(winner.computedAt, intOrDefault(winner.closedAt, Date.now()));
  await Promise.all(matchingOffers.map(([offerId, offer]) => {
    const award = {
      offerId,
      showId,
      eligibility,
      prizeType: prizeTypeOf(offer),
      title: offer.title ?? "Show prize",
      description: offer.description ?? null,
      awardedAt,
      sourceAwardKey: awardKey,
      sourceWinnerPoints: intOrDefault(winner.points, 0),
      displayName: winner.displayName ?? "Guest",
      setNumber: setNumber ?? null,
      claimed: false,
    };
    return database
      .ref(showPath(root, showId, `offer_awards/${winner.uid}/${offerId}`))
      .set(award);
  }));

  logger.info("Offer awards materialized", {
    showId,
    uid: winner.uid,
    eligibility,
    awardKey,
    offerCount: matchingOffers.length,
    root,
  });
}

function makeSetWinnerOfferAwarder(namespacePrefix: string) {
  const root = namespaceRoot(namespacePrefix);

  return onValueWritten(
    { ref: `${root}/shows/{showId}/set_winners/{setNumber}`, region: REGION },
    async (event: DatabaseEvent<Change<DataSnapshot>, WinnerParams>) => {
      if (!event.data.after.exists() || event.data.before.exists()) return null;
      const winner = event.data.after.val() as WinnerResult | null;
      if (!winner) return null;
      const setNumber = intOrDefault(Number(event.params.setNumber), 0);
      if (setNumber <= 0) return null;

      await materializeWinnerAwards({
        database: admin.database(),
        root,
        showId: event.params.showId,
        winner,
        eligibility: "set_winner",
        awardKey: `set_${setNumber}`,
        setNumber,
      });
      return null;
    }
  );
}

function makeNightWinnerOfferAwarder(namespacePrefix: string) {
  const root = namespaceRoot(namespacePrefix);

  return onValueWritten(
    { ref: `${root}/shows/{showId}/night_winner`, region: REGION },
    async (event: DatabaseEvent<Change<DataSnapshot>, WinnerParams>) => {
      if (!event.data.after.exists() || event.data.before.exists()) return null;
      const winner = event.data.after.val() as WinnerResult | null;
      if (!winner) return null;

      await materializeWinnerAwards({
        database: admin.database(),
        root,
        showId: event.params.showId,
        winner,
        eligibility: "night_winner",
        awardKey: "night",
      });
      return null;
    }
  );
}

async function getDisplayName(database: admin.database.Database, root: string, showId: string, uid: string): Promise<string> {
  const [attendeeSnap, memberSnap] = await Promise.all([
    database.ref(showPath(root, showId, `attendees/${uid}/display_name`)).get(),
    database.ref(rootPath(root, `members/${uid}/display_name`)).get(),
  ]);
  return (
    (typeof attendeeSnap.val() === "string" && attendeeSnap.val()) ||
    (typeof memberSnap.val() === "string" && memberSnap.val()) ||
    "Guest"
  );
}

async function claimOfferForUser(params: {
  database: admin.database.Database;
  root: string;
  showId: string;
  offerId: string;
  uid: string;
}): Promise<OfferClaim> {
  const { database, root, showId, offerId, uid } = params;
  const offerRef = database.ref(showPath(root, showId, `offers/${offerId}`));
  const claimRef = database.ref(showPath(root, showId, `offer_claims/${uid}/${offerId}`));
  const awardRef = database.ref(showPath(root, showId, `offer_awards/${uid}/${offerId}`));
  const memberClaimKey = `${showId}_${offerId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const memberClaimRef = database.ref(rootPath(root, `offer_claims_by_uid/${uid}/${memberClaimKey}`));

  const existingClaimSnap = await claimRef.get();
  if (existingClaimSnap.exists()) {
    return existingClaimSnap.val() as OfferClaim;
  }

  const [offerSnap, awardSnap, displayName] = await Promise.all([
    offerRef.get(),
    awardRef.get(),
    getDisplayName(database, root, showId, uid),
  ]);
  if (!offerSnap.exists()) {
    throw new HttpsError("not-found", "Offer not found.");
  }

  const offer = offerSnap.val() as ShowOffer;
  if (offer.active !== true) {
    throw new HttpsError("failed-precondition", "This offer is not active.");
  }

  const eligibility = offer.eligibility as OfferEligibility | undefined;
  if (eligibility !== "broadcast" && eligibility !== "set_winner" && eligibility !== "night_winner") {
    throw new HttpsError("failed-precondition", "This offer is not claimable.");
  }
  if (eligibility !== "broadcast" && !awardSnap.exists()) {
    throw new HttpsError("permission-denied", "This prize is not assigned to this account.");
  }

  const pendingToken = randomBytes(8).toString("hex");
  const pendingResult = await claimRef.transaction((current) => {
    if (current) return current;
    return {
      claim_status: "pending",
      pending_token: pendingToken,
      created_at: admin.database.ServerValue.TIMESTAMP,
    };
  });

  const pendingValue = pendingResult.snapshot.val() as Record<string, unknown> | null;
  if (!pendingResult.committed || pendingValue?.claim_status !== "pending" || pendingValue?.pending_token !== pendingToken) {
    const current = pendingResult.snapshot.val();
    if (current && typeof (current as Record<string, unknown>).voucherCode === "string") {
      return current as OfferClaim;
    }
    throw new HttpsError("aborted", "This prize claim is already in progress.");
  }

  const countResult = await offerRef.transaction((current) => {
    const currentOffer = current as ShowOffer | null;
    if (!currentOffer || currentOffer.active !== true) return undefined;
    const cap = intOrDefault(currentOffer.total_quantity, 0);
    const claimedCount = intOrDefault(currentOffer.claimed_count, 0);
    if (cap > 0 && claimedCount >= cap) return undefined;
    return {
      ...currentOffer,
      claimed_count: claimedCount + 1,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    };
  });

  if (!countResult.committed) {
    await claimRef.remove();
    throw new HttpsError("resource-exhausted", "This offer has already been fully claimed.");
  }

  const awardValue = (awardSnap.val() as Record<string, unknown> | null) ?? null;
  const now = Date.now();
  const claim: OfferClaim = {
    showId,
    offerId,
    uid,
    displayName,
    offerTitle: offer.title ?? "Show prize",
    offerDescription: offer.description ?? null,
    prizeType: prizeTypeOf(offer),
    eligibility,
    voucherCode: makeVoucherCode(),
    claimed_at: now,
    redeemed: false,
    redeemed_at: null,
    sourceAwardKey: typeof awardValue?.sourceAwardKey === "string" ? awardValue.sourceAwardKey : null,
    sourceWinnerPoints: typeof awardValue?.sourceWinnerPoints === "number" ? awardValue.sourceWinnerPoints : null,
  };

  await Promise.all([
    claimRef.set(claim),
    memberClaimRef.set(claim),
    awardRef.child("claimed").set(true),
    awardRef.child("claimedAt").set(now),
  ]);

  return claim;
}

export const claimOffer = onCall(
  { region: REGION, enforceAppCheck: REQUIRE_APP_CHECK },
  async (request) => {
    const authRequest = requireAuth(request, null, {
      keyPrefix: "claimOffer",
      maxCalls: 20,
      windowMs: 60 * 1000,
    });
    const data = request.data as ClaimOfferInput;
    const showId = stringInput(data.showId, "showId");
    const offerId = stringInput(data.offerId, "offerId");
    const root = rootFromCallableInput(data.isTestShow);

    const claim = await claimOfferForUser({
      database: admin.database(),
      root,
      showId,
      offerId,
      uid: authRequest.auth.uid,
    });

    return publicClaim(claim);
  }
);

export const redeemOfferClaim = onCall(
  { region: REGION, enforceAppCheck: REQUIRE_APP_CHECK },
  async (request) => {
    const authRequest = requireAuth(request, null, {
      keyPrefix: "redeemOfferClaim",
      maxCalls: 30,
      windowMs: 60 * 1000,
    });
    const data = request.data as RedeemOfferInput;
    const showId = stringInput(data.showId, "showId");
    const offerId = stringInput(data.offerId, "offerId");
    const root = rootFromCallableInput(data.isTestShow);
    const uid = authRequest.auth.uid;
    const memberClaimKey = `${showId}_${offerId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const now = Date.now();

    const claimRef = admin.database().ref(showPath(root, showId, `offer_claims/${uid}/${offerId}`));
    const claimSnap = await claimRef.get();
    if (!claimSnap.exists()) {
      throw new HttpsError("not-found", "Claim not found.");
    }

    await Promise.all([
      claimRef.update({ redeemed: true, redeemed_at: now }),
      admin.database().ref(rootPath(root, `offer_claims_by_uid/${uid}/${memberClaimKey}`)).update({
        redeemed: true,
        redeemed_at: now,
      }),
    ]);

    return {
      ok: true,
      redeemedAt: now,
    };
  }
);

export const setWinnerOfferAwarder = makeSetWinnerOfferAwarder("");
export const setWinnerOfferAwarderTest = makeSetWinnerOfferAwarder("test");
export const nightWinnerOfferAwarder = makeNightWinnerOfferAwarder("");
export const nightWinnerOfferAwarderTest = makeNightWinnerOfferAwarder("test");
