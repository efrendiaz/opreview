// Confluence Cloud client. Uses the same Atlassian email + API token as Jira.
// JIRA_BASE_URL points at the instance root (e.g. https://babbel.atlassian.net);
// Confluence lives at /wiki on the same domain.

function baseUrl() {
  const jira = process.env.JIRA_BASE_URL;
  if (!jira) throw new Error('JIRA_BASE_URL not set in .env');
  return `${jira.replace(/\/$/, '')}/wiki`;
}

function authHeader() {
  const { JIRA_EMAIL, JIRA_TOKEN } = process.env;
  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    throw new Error('JIRA_EMAIL and JIRA_TOKEN must be set in .env (same Atlassian token used for Jira)');
  }
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  return `Basic ${auth}`;
}

async function confluenceFetch(path, init = {}) {
  const url = baseUrl() + path;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      ...(init.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Confluence ${path} → ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

export async function getCurrentUser() {
  return confluenceFetch('/rest/api/user/current');
}

export async function getFolder(id) {
  return confluenceFetch(`/api/v2/folders/${encodeURIComponent(id)}`);
}

export async function getSpaceById(spaceId) {
  return confluenceFetch(`/api/v2/spaces/${encodeURIComponent(spaceId)}`);
}

// Pings the API and the team's parent folder, returning enough info for the
// CLI to print a friendly access-check report.
export async function checkAccess(team) {
  const cp = team.confluenceParent;
  if (!cp || !cp.folderId) {
    throw new Error(`Team "${team.name}" has no confluenceParent.folderId in teams.json`);
  }
  const user = await getCurrentUser();
  const folder = await getFolder(cp.folderId);
  let space = null;
  if (folder.spaceId) {
    space = await getSpaceById(folder.spaceId);
  }
  return { user, folder, space };
}

// Find an existing page by exact title under the given parent folder. Returns
// the matching page (with id + version) or null.
async function findPageByTitle({ spaceId, parentId, title }) {
  // v2 API filters by space-id + title (exact match). The API doesn't take
  // parent-id as a filter directly, so we post-filter on parentId.
  const url = `/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&title=${encodeURIComponent(title)}&body-format=storage&limit=50`;
  const data = await confluenceFetch(url);
  const matches = (data.results || []).filter(p => String(p.parentId) === String(parentId));
  return matches[0] || null;
}

async function createPage({ spaceId, parentId, title, storage }) {
  const body = {
    spaceId: String(spaceId),
    status: 'current',
    title,
    parentId: String(parentId),
    body: { representation: 'storage', value: storage }
  };
  return confluenceFetch('/api/v2/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function updatePage({ id, currentVersion, title, storage }) {
  const body = {
    id: String(id),
    status: 'current',
    title,
    body: { representation: 'storage', value: storage },
    version: { number: currentVersion + 1, message: 'opreview update' }
  };
  return confluenceFetch(`/api/v2/pages/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// Publish (create or update) a page under the team's parent folder. Idempotent
// by exact title match within the folder. Returns { page, created } where
// page has id, title, version, and a webui link to view it.
export async function publishPage(team, title, storage) {
  const cp = team.confluenceParent;
  if (!cp || !cp.folderId) {
    throw new Error(`Team "${team.name}" has no confluenceParent.folderId in teams.json`);
  }
  const folder = await getFolder(cp.folderId);
  const spaceId = folder.spaceId;
  if (!spaceId) {
    throw new Error(`Folder ${cp.folderId} has no spaceId — cannot publish`);
  }

  const existing = await findPageByTitle({ spaceId, parentId: cp.folderId, title });
  if (existing) {
    const page = await updatePage({
      id: existing.id,
      currentVersion: existing.version?.number || 1,
      title,
      storage
    });
    return { page, created: false };
  }
  const page = await createPage({ spaceId, parentId: cp.folderId, title, storage });
  return { page, created: true };
}

// Build a link to view the page in the Confluence UI from the v2 API response.
export function pageWebUrl(page) {
  const base = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '') + '/wiki';
  const webuiPath = page._links?.webui;
  if (webuiPath) return base + webuiPath;
  return `${base}/pages/viewpage.action?pageId=${encodeURIComponent(page.id)}`;
}

// Find an attachment on a page by filename. Uses the v1 attachment API
// because the v2 attachments endpoint doesn't expose a filename filter.
async function findAttachment(pageId, filename) {
  const path = `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?filename=${encodeURIComponent(filename)}`;
  const data = await confluenceFetch(path);
  return data.results?.[0] || null;
}

// Idempotent attachment upload. If an attachment with the same filename
// already exists on the page, this uploads a new version of it; otherwise
// creates a fresh one. Returns the attachment metadata (id, title, version).
//
// Confluence requires multipart/form-data with the X-Atlassian-Token header
// set to "nocheck" (otherwise XSRF protection blocks programmatic uploads).
export async function uploadAttachment(pageId, filename, buffer, mimeType = 'image/png') {
  const existing = await findAttachment(pageId, filename);
  const path = existing
    ? `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${encodeURIComponent(existing.id)}/data`
    : `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  form.append('minorEdit', 'true');

  const url = baseUrl() + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'X-Atlassian-Token': 'nocheck'
    },
    body: form
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Confluence attach ${path} → ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  // The "create" endpoint returns { results: [{...}] }; the "update by id"
  // endpoint returns the attachment object directly. Normalise.
  return data.results ? data.results[0] : data;
}
