type EmailTemplate = {
  subject: string;
  html: string;
  text: string;
};

const FOOTER_LINE = "Tickets sold by The Adele Show. Payments processed securely by Stripe.";

export function emailBrand(sellingFrontId?: string): { brandName: string } {
  return {
    brandName: sellingFrontId === "adele_show" ? "The Adele Show" : "Hollywood Groove",
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function nameOrFallback(name: string | null | undefined, fallback: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed || fallback;
}

function ticketLabel(ticketCount: number): string {
  return `${ticketCount} ticket${ticketCount === 1 ? "" : "s"}`;
}

function dateLine(showStartDateText?: string | null): string {
  return showStartDateText ? `Show time: ${showStartDateText}` : "";
}

function renderHtml(params: {
  brandName: string;
  title: string;
  greeting: string;
  paragraphs: string[];
  ctaLabel: string;
  ctaUrl: string;
}): string {
  const paragraphHtml = params.paragraphs
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) =>
      `<p style="margin:0 0 16px;color:#d1d5db;font-size:16px;line-height:1.6;">${paragraph}</p>`
    )
    .join("");

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0b1120;font-family:Arial,Helvetica,sans-serif;color:#f9fafb;">
    <div style="display:none;max-height:0;overflow:hidden;color:#0b1120;">${escapeHtml(params.title)}</div>
    <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
      <div style="background:#111827;border:1px solid #273244;border-radius:8px;padding:28px;">
        <p style="margin:0 0 10px;color:#f59e0b;font-size:13px;font-weight:700;letter-spacing:0;text-transform:uppercase;">${escapeHtml(params.brandName)}</p>
        <h1 style="margin:0 0 20px;color:#ffffff;font-size:24px;line-height:1.25;font-weight:700;">${escapeHtml(params.title)}</h1>
        <p style="margin:0 0 16px;color:#e5e7eb;font-size:16px;line-height:1.6;">${escapeHtml(params.greeting)}</p>
        ${paragraphHtml}
        <p style="margin:24px 0 28px;">
          <a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;background:#f59e0b;color:#111827;text-decoration:none;font-weight:700;font-size:16px;line-height:1.2;padding:14px 18px;border-radius:6px;">${escapeHtml(params.ctaLabel)}</a>
        </p>
        <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.5;">${escapeHtml(FOOTER_LINE)}</p>
      </div>
    </div>
  </body>
</html>`;
}

function renderText(lines: string[]): string {
  return [...lines.filter((line) => line.length > 0), "", FOOTER_LINE].join("\n");
}

export function ticketReadyEmail(p: {
  sellingFrontId?: string;
  buyerName?: string | null;
  showTitle: string;
  showStartDateText?: string | null;
  ticketCount: number;
  walletUrl: string;
}): EmailTemplate {
  const { brandName } = emailBrand(p.sellingFrontId);
  const tickets = ticketLabel(p.ticketCount);
  const title = "Your tickets are ready";
  const greeting = `Hi ${nameOrFallback(p.buyerName, "there")},`;
  const showTitle = nameOrFallback(p.showTitle, "your show");
  const paragraphs = [
    `Your ${tickets} for ${escapeHtml(showTitle)} ${p.ticketCount === 1 ? "is" : "are"} ready in your wallet.`,
    escapeHtml(dateLine(p.showStartDateText)),
    "You can open your wallet from your phone and have the ticket ready at the door.",
  ];

  return {
    subject: `${brandName}: your ${showTitle} tickets are ready`,
    html: renderHtml({
      brandName,
      title,
      greeting,
      paragraphs,
      ctaLabel: "Open your wallet",
      ctaUrl: p.walletUrl,
    }),
    text: renderText([
      title,
      greeting,
      `Your ${tickets} for ${showTitle} ${p.ticketCount === 1 ? "is" : "are"} ready in your wallet.`,
      dateLine(p.showStartDateText),
      `Open your wallet: ${p.walletUrl}`,
    ]),
  };
}

export function refundConfirmationEmail(p: {
  sellingFrontId?: string;
  buyerName?: string | null;
  showTitle: string;
  amountText: string;
  walletUrl: string;
}): EmailTemplate {
  const { brandName } = emailBrand(p.sellingFrontId);
  const title = "Refund confirmation";
  const greeting = `Hi ${nameOrFallback(p.buyerName, "there")},`;
  const showTitle = nameOrFallback(p.showTitle, "your show");
  const paragraphs = [
    `A refund of ${escapeHtml(p.amountText)} has been processed for ${escapeHtml(showTitle)}.`,
    "Stripe may take several business days to return funds to the cardholder.",
  ];

  return {
    subject: `${brandName}: refund confirmation for ${showTitle}`,
    html: renderHtml({
      brandName,
      title,
      greeting,
      paragraphs,
      ctaLabel: "View your wallet",
      ctaUrl: p.walletUrl,
    }),
    text: renderText([
      title,
      greeting,
      `A refund of ${p.amountText} has been processed for ${showTitle}.`,
      "Stripe may take several business days to return funds to the cardholder.",
      `View your wallet: ${p.walletUrl}`,
    ]),
  };
}

export function compTicketEmail(p: {
  sellingFrontId?: string;
  recipientName?: string | null;
  showTitle: string;
  showStartDateText?: string | null;
  ticketCount: number;
  walletUrl: string;
}): EmailTemplate {
  const { brandName } = emailBrand(p.sellingFrontId);
  const tickets = ticketLabel(p.ticketCount);
  const title = "Your comp tickets are ready";
  const greeting = `Hi ${nameOrFallback(p.recipientName, "there")},`;
  const showTitle = nameOrFallback(p.showTitle, "your show");
  const paragraphs = [
    `${escapeHtml(brandName)} has issued ${tickets} for ${escapeHtml(showTitle)} to your wallet.`,
    escapeHtml(dateLine(p.showStartDateText)),
    "Open your wallet from your phone and have the ticket ready at the door.",
  ];

  return {
    subject: `${brandName}: your ${showTitle} comp tickets are ready`,
    html: renderHtml({
      brandName,
      title,
      greeting,
      paragraphs,
      ctaLabel: "Open your wallet",
      ctaUrl: p.walletUrl,
    }),
    text: renderText([
      title,
      greeting,
      `${brandName} has issued ${tickets} for ${showTitle} to your wallet.`,
      dateLine(p.showStartDateText),
      `Open your wallet: ${p.walletUrl}`,
    ]),
  };
}

export function signInLinkEmail(p: {
  sellingFrontId?: string;
  signInUrl: string;
}): EmailTemplate {
  const { brandName } = emailBrand(p.sellingFrontId);
  const title = "Your sign-in link";
  const greeting = "Hi there,";
  const paragraphs = [
    `Tap the button below to sign in to ${escapeHtml(brandName)} and get to your tickets. The link signs you in on this device — no password needed.`,
    "For your security it can only be used once and expires shortly. If you didn't ask to sign in, you can safely ignore this email.",
  ];

  return {
    subject: `Sign in to ${brandName}`,
    html: renderHtml({
      brandName,
      title,
      greeting,
      paragraphs,
      ctaLabel: "Sign in",
      ctaUrl: p.signInUrl,
    }),
    text: renderText([
      title,
      greeting,
      `Tap to sign in to ${brandName}: ${p.signInUrl}`,
      "The link can only be used once and expires shortly. If you didn't ask to sign in, you can ignore this email.",
    ]),
  };
}

export function shareInviteEmail(p: {
  sellingFrontId?: string;
  sharerName?: string | null;
  recipientName?: string | null;
  showTitle: string;
  showStartDateText?: string | null;
  claimUrl: string;
}): EmailTemplate {
  const { brandName } = emailBrand(p.sellingFrontId);
  const sharerName = nameOrFallback(p.sharerName, brandName);
  const showTitle = nameOrFallback(p.showTitle, "the show");
  const title = "A ticket has been sent to you";
  const greeting = `Hi ${nameOrFallback(p.recipientName, "there")},`;
  const paragraphs = [
    `${escapeHtml(sharerName)} has sent you a ticket to ${escapeHtml(showTitle)}.`,
    escapeHtml(dateLine(p.showStartDateText)),
    "Sign in or sign up with this email address and the ticket will appear in your wallet.",
  ];

  return {
    subject: `${sharerName} sent you a ticket to ${showTitle}`,
    html: renderHtml({
      brandName,
      title,
      greeting,
      paragraphs,
      ctaLabel: "View your ticket",
      ctaUrl: p.claimUrl,
    }),
    text: renderText([
      title,
      greeting,
      `${sharerName} has sent you a ticket to ${showTitle}.`,
      dateLine(p.showStartDateText),
      "Sign in or sign up with this email address and the ticket will appear in your wallet.",
      `View your ticket: ${p.claimUrl}`,
    ]),
  };
}
