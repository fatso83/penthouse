let path = require('path');
let fs = require('fs');
let read = fs.readFileSync;
let css = require('css');
let chai = require('chai');
let should = chai.should();// extends Object.prototype (so ignore unused warnings)


let cssPreformatCssFilePath = path.join(__dirname, 'static-server', 'preformat-css--remove.css'),
	cssPreformatCss = read(cssPreformatCssFilePath).toString(),
	cssPreformatter = require('../lib/phantomjs/css-preformatter.js');

describe('css preformatter', () => {

	it('should preformat css (rm comments etc)', () => {

		let result = cssPreformatter(cssPreformatCss);

		let resultAst = css.parse(result);
		let orgAst = css.parse(cssPreformatCss);

		//with comments stripped out, fewer 'rules' (comments included) in AST
		resultAst.stylesheet.rules.should.have.length.lessThan(orgAst.stylesheet.rules.length);

		//but except for comments, (also inside declarations), everything should be the same
		let orgAstRulesExceptComments = orgAst.stylesheet.rules.filter((rule) => {
			if (typeof rule.declarations !== "undefined") {
				rule.declarations = rule.declarations.filter((declaration) => {
					return declaration.type !== "comment"
				})
			}
			return rule.type !== "comment";
		});

		orgAstRulesExceptComments.should.eql(resultAst.stylesheet.rules);
	});

})
