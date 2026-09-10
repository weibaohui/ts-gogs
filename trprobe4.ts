import { TemplateSet, goSprintf } from './src/gotemplate/engine.js';
import { buildFuncMap } from './src/gotemplate/funcs.js';
const set = new TemplateSet();
set.funcs = buildFuncMap();
set.parse('vt', `{{$.i18n.Tr "repo.pulls.title_desc" .NumCommits .HeadTarget .BaseTarget | Str2HTML}}`);
const Issue: any = { NumCommits: 2, HeadTarget: 'root/project-x:master', BaseTarget: 'root:master' };
const data: any = {
  i18n: { Tr: (key: string, ...a: any[]) => goSprintf('wants to merge %[1]d commits from <code>%[2]s</code> into <code>%[3]s</code>', a) },
  Issue,
  NumCommits: 2, HeadTarget: 'H', BaseTarget: 'B',
};
console.log('OUT:', set.render('vt', data));
process.exit(0);
