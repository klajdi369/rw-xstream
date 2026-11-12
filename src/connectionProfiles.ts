export type Credentials = {
  server: string;
  user: string;
  pass: string;
};

export type ConnectionProfile = Credentials & { name: string };

// Store each profile under its own key so saving one doesn't rewrite the others.
export const PROFILE_KEY_PREFIX = 'xtream_profile:';

export function readConnectionProfiles(): ConnectionProfile[] {
  let keys: string[];
  try {
    keys = Object.keys(localStorage);
  } catch {
    return [];
  }

  const profiles: ConnectionProfile[] = [];
  for (const key of keys) {
    if (!key.startsWith(PROFILE_KEY_PREFIX)) continue;
    const name = key.slice(PROFILE_KEY_PREFIX.length);
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      if (name && typeof value?.server === 'string' && typeof value.user === 'string' && typeof value.pass === 'string') {
        profiles.push({ name, server: value.server, user: value.user, pass: value.pass });
      }
    } catch {
      // Skip an unreadable profile without hiding the rest.
    }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}
