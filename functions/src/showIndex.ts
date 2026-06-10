import * as admin from "firebase-admin";
import { logger } from "firebase-functions/v2";
import { onValueWritten } from "firebase-functions/v2/database";

type ShowMeta = Record<string, unknown>;

type ShowIndexProjection = {
  title: string;
  startDate: string;
  status?: string;
  isTestShow?: boolean;
  is_test?: boolean;
  test?: boolean;
  venueName?: string;
  ticketUrl?: string;
  orgId?: string;
  platformOwner?: string;
  schemaVersion?: number;
  publishedAt?: number;
  updatedAt: object;
};

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function compactProjection(value: ShowIndexProjection): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function projectShowMeta(meta: ShowMeta, isTestNamespace: boolean): Record<string, unknown> | null {
  const title = stringOrUndefined(meta.title);
  if (!title) {
    return null;
  }

  const isTestShow =
    booleanOrUndefined(meta.isTestShow) ??
    booleanOrUndefined(meta.is_test) ??
    booleanOrUndefined(meta.test) ??
    isTestNamespace;

  return compactProjection({
    title,
    startDate: stringOrUndefined(meta.startDate) ?? "",
    status: stringOrUndefined(meta.status),
    isTestShow,
    is_test: isTestShow,
    test: isTestShow,
    venueName: stringOrUndefined(meta.venueName),
    ticketUrl: stringOrUndefined(meta.ticketUrl),
    orgId: stringOrUndefined(meta.orgId),
    platformOwner: stringOrUndefined(meta.platformOwner),
    schemaVersion: numberOrUndefined(meta.schemaVersion),
    publishedAt: numberOrUndefined(meta.publishedAt),
    updatedAt: admin.database.ServerValue.TIMESTAMP,
  });
}

function makeShowIndexMirror(namespacePrefix: "" | "test") {
  const root = namespacePrefix ? `${namespacePrefix}/` : "";
  const sourcePath = `${root}shows/{showId}/meta`;
  const indexPath = `${root}shows_index`;
  const isTestNamespace = namespacePrefix === "test";

  return onValueWritten(
    { ref: sourcePath, region: "asia-southeast1" },
    async (event) => {
      const { showId } = event.params;
      const indexRef = admin.database().ref(`${indexPath}/${showId}`);

      if (!event.data.after.exists()) {
        await indexRef.remove();
        logger.info("Removed show index projection", { showId, namespacePrefix });
        return null;
      }

      const projection = projectShowMeta(
        event.data.after.val() as ShowMeta,
        isTestNamespace,
      );
      if (!projection) {
        await indexRef.remove();
        logger.warn("Removed show index projection for incomplete metadata", {
          showId,
          namespacePrefix,
        });
        return null;
      }

      await indexRef.set(projection);
      logger.info("Updated show index projection", { showId, namespacePrefix });
      return null;
    },
  );
}

export const mirrorShowMetaToIndex = makeShowIndexMirror("");
export const mirrorTestShowMetaToIndex = makeShowIndexMirror("test");
