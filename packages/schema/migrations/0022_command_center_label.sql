-- Content handoff run 3 (docs/22 ADR-C6). The visible name "AI CEO" becomes "Command Center". Display only: the template
-- key stays 'ceo', so policy, tools and versions are untouched. A name someone changed is kept.
-- Recovery: update agents set name='AI CEO' where template='ceo' and name='Command Center';
update agents set name = 'Command Center' where template = 'ceo' and name = 'AI CEO';
