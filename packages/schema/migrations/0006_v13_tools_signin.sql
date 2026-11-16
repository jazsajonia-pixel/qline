-- v1.3: Sign in with Google handshake + new assistant tools on existing agents.

-- Short-lived Google sign-in handshakes (pre-auth, so no org and no RLS). Rows expire after 30 minutes.
create table if not exists signin_requests (
  state text primary key,
  nonce_hash text not null,
  verifier text not null,
  token_ciphertext text,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists signin_requests_nonce on signin_requests (nonce_hash);
grant select, insert, update, delete on signin_requests to qline_app;

-- Add the new tools to each agent's current version, matching the template defaults in @qline/policy.
update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array[
     'gmail.search','gmail.read','calendar.list','leads.list','approvals.list','workflows.list',
     'forms.responses','forms.create','sheets.create','notify.me']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version;

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['calendar.create']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template <> 'research';

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['contacts.create','slack.post','email.send']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo','sales','marketing','operations');

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['workflows.run']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo','operations');
