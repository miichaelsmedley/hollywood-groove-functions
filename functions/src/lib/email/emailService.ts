import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import {
  getEmailFromAddress,
  getResendApiKey,
  getTicketingDb,
} from "../../ticketing/config";

export type EmailMessage = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

export type EmailSendResult = {
  delivered: boolean;
  provider: "resend" | "stub";
  id?: string;
  error?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string): string {
  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
}

export async function sendEmail(msg: EmailMessage): Promise<EmailSendResult> {
  let provider: EmailSendResult["provider"] = "stub";

  try {
    const key = getResendApiKey();
    const from = getEmailFromAddress();

    if (!key) {
      logger.info("[email:stub] suppressed (no RESEND_API_KEY)", {
        to: msg.to,
        subject: msg.subject,
      });
      try {
        await getTicketingDb().collection("mailLog").doc().set({
          to: msg.to,
          subject: msg.subject,
          provider: "stub",
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (error) {
        logger.warn("[email:stub] mailLog write failed", {
          to: msg.to,
          subject: msg.subject,
          error: errorMessage(error),
        });
      }
      return { delivered: false, provider: "stub" };
    }

    provider = "resend";
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(msg.to) ? msg.to : [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        reply_to: msg.replyTo,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = `Resend returned ${response.status} ${response.statusText}`.trim()
        + (body ? `: ${truncate(body)}` : "");
      logger.error("[email] resend send failed", {
        to: msg.to,
        subject: msg.subject,
        status: response.status,
        error,
      });
      return { delivered: false, provider: "resend", error };
    }

    const payload = await response.json().catch(() => null) as { id?: unknown } | null;
    return {
      delivered: true,
      provider: "resend",
      id: typeof payload?.id === "string" ? payload.id : undefined,
    };
  } catch (error) {
    const message = errorMessage(error);
    logger.error(
      provider === "resend"
        ? "[email] resend send failed"
        : "[email] send failed",
      {
        to: msg.to,
        subject: msg.subject,
        error: message,
      },
    );
    return { delivered: false, provider, error: message };
  }
}
