import { goSprintf } from './src/gotemplate/engine.js';
// exactly the positional flow: %[1]d %[2]s %[3]s
console.log(goSprintf('wants to merge %[1]d commits from <code>%[2]s</code> into <code>%[3]s</code>', [2, 'head', 'base']));
// mixed: %s then %[2]s (create_pull_request style)
console.log(goSprintf('`created pull request <a href="%s/pulls/%s">%s#%[2]s</a>`', ['/r/p', '3', 'r/p']));
// what if args arrive as [NaN-ish]?
console.log(goSprintf('wants to merge %[1]d commits', [undefined]));
