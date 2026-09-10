import { TemplateSet, goSprintf } from './src/gotemplate/engine.js';
const set = new TemplateSet();
set.funcs = (() => {
  const m: Record<string, any> = {};
  return m;
})();
// use real funcs (Str2HTML needed)
const { buildFuncMap } = await import('./src/gotemplate/funcs.js');
set.funcs = buildFuncMap();
set.parse('t', '{{$index := index .GetIssueInfos 0}}{{$r := $.i18n.Tr "action.create_pull_request" .GetRepoLink $index .ShortRepoPath}}[{{$r}}]');
const action: any = {
  GetRepoLink: () => '/root/project-x',
  ShortRepoPath: () => 'root/project-x',
  GetIssueInfos: () => ['3'],
  i18n: { Tr: (key: string, ...a: any[]) => goSprintf('`created pull request <a href="%s/pulls/%s">%s#%[2]s</a>`', a) },
  Tr: undefined,
};
set.funcs.Tr = undefined as any;
// register Tr as data at top level: wrap in root object
const out = set.render('t', { i18n: action.i18n, GetIssueInfos: action.GetIssueInfos, GetRepoLink: action.GetRepoLink, ShortRepoPath: action.ShortRepoPath });
console.log('OUT:', out);
process.exit(0);
