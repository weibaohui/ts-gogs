import { goSprintf, goEscape } from './src/gotemplate/engine.js';
const locale = '`created pull request <a href="%s/pulls/%s">%s#%[2]s</a>`';
const args = ['/root/project-x', '3', 'root/project-x'];
console.log('A:', goSprintf(locale, args));
// simulate undefined args
console.log('B:', goSprintf(locale, [undefined, undefined, undefined]));
const locale2 = 'pushed to <a href="%[1]s/src/%[2]s">%[3]s</a> at <a href="%[1]s">%[4]s</a>';
console.log('C:', goSprintf(locale2, ['/root/project-x', 'master', 'master', 'root/project-x']));
console.log('D:', goSprintf(locale2, ['/root/project-x', 'master', 'master', undefined]));
