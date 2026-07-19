import type { RemoteProfile } from "./remote";

const STORAGE_KEY = "agent-ui.remoteProfiles.v1";
const ACTIVE_KEY = "agent-ui.activeRemoteProfileId.v1";

function normalizeName(name: string): string {
  return name.trim();
}

function normalizeNameKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function stableProfileIdFromName(name: string): string {
  let hash = 2166136261;

  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `remote-${(hash >>> 0).toString(36)}`;
}

function dedupeProfiles(profiles: RemoteProfile[]): RemoteProfile[] {
  const byName = new Map<string, RemoteProfile>();

  for (const profile of profiles) {
    const name = normalizeName(profile.name);
    if (!name) continue;

    byName.set(normalizeNameKey(name), {
      ...profile,
      name,
      baseUrl: normalizeBaseUrl(profile.baseUrl),
      token: profile.token?.trim() || undefined,
    });
  }

  return [...byName.values()];
}

function safeParseProfiles(raw: string | null): RemoteProfile[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return dedupeProfiles(
      parsed.filter(
        (item): item is RemoteProfile =>
          typeof item?.id === "string" &&
          typeof item?.name === "string" &&
          typeof item?.baseUrl === "string" &&
          (typeof item?.token === "string" || typeof item?.token === "undefined"),
      ),
    );
  } catch {
    return [];
  }
}

export function loadRemoteProfiles(): RemoteProfile[] {
  const profiles = safeParseProfiles(window.localStorage.getItem(STORAGE_KEY));

  // One-time cleanup of old duplicate records: for the same name, keep only the last one.
  saveRemoteProfiles(profiles);

  return profiles;
}

export function saveRemoteProfiles(profiles: RemoteProfile[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dedupeProfiles(profiles)));
}

export function upsertRemoteProfile(profile: RemoteProfile): RemoteProfile[] {
  const name = normalizeName(profile.name);
  const normalizedProfile: RemoteProfile = {
    ...profile,
    name,
    baseUrl: normalizeBaseUrl(profile.baseUrl),
    token: profile.token?.trim() || undefined,
  };

  const profiles = loadRemoteProfiles();

  const existing = profiles.find(
    (item) =>
      item.id === normalizedProfile.id ||
      normalizeNameKey(item.name) === normalizeNameKey(normalizedProfile.name),
  );

  const next = existing
    ? profiles.map((item) =>
        item.id === existing.id
          ? {
              ...normalizedProfile,
              id: existing.id,
            }
          : item,
      )
    : [...profiles, normalizedProfile];

  saveRemoteProfiles(next);
  return loadRemoteProfiles();
}

export function deleteRemoteProfile(profileId: string): RemoteProfile[] {
  const next = loadRemoteProfiles().filter((profile) => profile.id !== profileId);
  saveRemoteProfiles(next);

  if (getActiveRemoteProfileId() === profileId) {
    clearActiveRemoteProfileId();
  }

  return loadRemoteProfiles();
}

export function getActiveRemoteProfileId(): string | null {
  return window.localStorage.getItem(ACTIVE_KEY);
}

export function setActiveRemoteProfileId(profileId: string): void {
  window.localStorage.setItem(ACTIVE_KEY, profileId);
}

export function clearActiveRemoteProfileId(): void {
  window.localStorage.removeItem(ACTIVE_KEY);
}

export function createRemoteProfileInput(input: {
  name: string;
  baseUrl: string;
  token?: string;
}): RemoteProfile {
  const name = normalizeName(input.name) || normalizeBaseUrl(input.baseUrl);
  const stableId = stableProfileIdFromName(name);

  return {
    id: stableId,
    name,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    token: input.token?.trim() || undefined,
  };
}
