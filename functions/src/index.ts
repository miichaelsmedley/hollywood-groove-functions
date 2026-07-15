import * as admin from "firebase-admin";

if (admin.apps.length === 0) {
  admin.initializeApp();
}

export { triviaScoring, triviaScoringTest } from "./scoring/triviaScoring";
export { dancingScoring, dancingScoringTest } from "./scoring/dancingScoring";
export {
  danceWindowOpenedScoring,
  danceWindowOpenedScoringTest,
  dancePresenceScoring,
  dancePresenceScoringTest,
  danceWindowSpotlightScoring,
  danceWindowSpotlightScoringTest,
} from "./scoring/danceWindows";
export { allTimeLeaderboard, allTimeLeaderboardTest } from "./scoring/allTimeLeaderboard";
export { teamScoring, teamScoringTest } from "./scoring/teamScoring";
export {
  setWinnerFinalizer,
  setWinnerFinalizerTest,
  nightWinnerFinalizer,
  nightWinnerFinalizerTest,
} from "./scoring/showResults";
export {
  claimOffer,
  redeemOfferClaim,
  setWinnerOfferAwarder,
  setWinnerOfferAwarderTest,
  nightWinnerOfferAwarder,
  nightWinnerOfferAwarderTest,
} from "./offers";
export { dailyTriviaAutoScheduler, dailyTriviaEngagementAutopilot } from "./scheduling/dailyTriviaScheduler";
export { whoAmI } from "./whoAmI";
export { setAdminClaim, syncTicketingAdminFromPrisUser } from "./setAdminClaim";
export { createCheckoutSession } from "./createCheckoutSession";
export { checkDisplayNameAvailable } from "./checkDisplayNameAvailable";
export { mirrorShowMetaToIndex, mirrorTestShowMetaToIndex } from "./showIndex";
export { stripeWebhook } from "./stripeWebhook";
export { expireReservations } from "./expireReservations";
export { grantVenueStaff, revokeVenueStaff } from "./grantVenueStaff";
export { grantOrganizationRole, revokeOrganizationRole } from "./grantOrganizationRole";
export { claimMyPendingVenueStaffInvites } from "./claimVenueStaffInvites";
export { validateTicketScan } from "./validateTicketScan";
export { refundOrder } from "./refundOrder";
export { issueCompTicket } from "./issueCompTicket";
export { shareTicket } from "./shareTicket";
export { claimMyPendingTickets } from "./claimMyPendingTickets";
export { sendEmailSignInLink } from "./sendEmailSignInLink";
export { searchPrisVenues, importPrisVenue } from "./importPrisVenue";
export {
  createTicketedShowFromGig,
  createTicketedShowFromPrisGig,
  listSelfTicketGigs,
} from "./createTicketedShowFromGig";

// One-time migration endpoint. Export only during Step 8, after whoAmI/setAdminClaim
// are deployed and the bootstrap account can prove admin claim access.
// export { migrateAdminsToCustomClaims } from "./migrateAdminsToCustomClaims";
