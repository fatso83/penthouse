'use strict';

var page = require('webpage').create(),
    fs = require('fs'),
    system = require('system'),
    stdout = system.stdout; // for using this as a file

// shortcut for logging
var log = function (msg) {
    console.log(msg);
};

// monkey patch for directing errors to stderr
// https://github.com/ariya/phantomjs/issues/10150#issuecomment-28707859
var errorlog = function () {
    system.stderr.write(Array.prototype.join.call(arguments, ' ') + '\n');
};

//don't confuse analytics more than necessary when visiting websites
page.settings.userAgent = 'Penthouse Critical Path CSS Generator';

/* prevent page JS errors from being output to final CSS */
page.onError = function (msg, trace) {
    //do nothing
};

var main = function (options) {

    var jobs = [];

    try {
        var f = fs.open(options.cssFile, "r");
        options.css = preFormatCSS(f.read());
    } catch (e) {
        errorlog(e);
        phantom.exit(1);
    }

    // since the various async operations might overlap it might make 
    // sense to not let them share the same object
    function createOptionsObject(urlIndex) {
        var clone = JSON.parse(JSON.stringify(options));
        delete clone.urls;
        clone.url = options.urls[urlIndex];
        return clone;
    }

    // support the standard old operation of logging to the console 
    if (options.urls.length === 1) {
        jobs.push(function(done) { getCssAndWriteToFile(stdout, createOptionsObject(0), done); });
    } else {
        options.urls.forEach(function(url, index) {
            jobs.push(function(done) {
                var fp = fs.open('critical-' + (index+1) + '.css', 'w');
                getCssAndWriteToFile(fp, createOptionsObject(0), function(err) {
                    fp.close();
                    if(err) { 
                        done(err);
                        return;
                    }
                    done();
                });
            });
        });
    }

    queueAsync(jobs, function(err) { 
        if(err) {
            errorlog(err);
            phantom.exit(1); 
        } else {
            phantom.exit(0);
        }
    })
};

/* Final function
 * Get's called from getCriticalPathCss when CSS extraction from page is done*/
page.onCallback = function(data) {
	//final cleanup
	//remove all empty rules, and remove leading/trailing whitespace
	var finalCss = data.replace(/[^{}]*\{\s*\}/gm, '').trim();
	//we're done, log the result as the output from phantomjs execution of this script!
	log(finalCss);

	phantom.exit();
};

// Queue async operations 
// @author fatso83@github
// Expect callbacks on the form  ( callback : (err?) => void )
function queueAsync(functions, callback) {
	var fns = functions.slice(0);
	var fn, iter;

	// functional looping, aka SICP 101 :)
	iter = function() {
		if(!fns.length) {
			// tell the mothership we want to go home
			callback();
			return;
		}

		// get first from queue
		fn = fns.splice(0,1)[0];
		fn(function(err) {
			if(err) callback(err);
			else iter();
		});
	};
	iter();
}

/**
 * Get the CSS and write to file
 * fp - a stream to write to
 * options - an options object with width, height, url and css
 * callback - a function that is called on finish, optionally with an error
 */
var getCssAndWriteToFile = function(fp, options, callback) {
	// start the critical path CSS generation
	getCriticalPathCss(options, function (css) {
		try {
			//we're done, log the result as the output from phantomjs execution of this script
			fp.write(css);

			callback();
		} catch(ex) {
			callback(ex);
		}
	});
}


/* === preFormatCSS ===
 * preformats the css to ensure we won't run into and problems in our parsing
 * removes comments (actually would be anough to remove/replace {} chars.. TODO
 * replaces } char inside content: "" properties.
 */
var preFormatCSS = function (css) {
    //remove comments from css (including multi-line coments)
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');

    //we also need to replace eventual close curly bracket characters inside content: "" property declarations, replace them with their ASCI code equivalent
    //\7d = '\' + '}'.charCodeAt(0).toString(16);
    
	var m,
		regexP = /(content\s*:\s*['"][^'"]*)}([^'"]*['"])/gm,
		matchedData = [];
	
	//for each content: "" rule that contains at least one end bracket ('}')
	while ((m = regexP.exec(css)) !== null) {
		//we need to replace ALL end brackets in the rule
		//we can't do it in here, because it will mess up ongoing exec, store data and do after
		
		//unshift - add to beginning of array - we need to remove rules in reverse order,
        //otherwise indeces will become incorrect.
		matchedData.unshift({
			start: m.index
			,end: m.index + m[0].length
			,replaceStr: m[0].replace(/\}/gm,"\\7d")
		});
	}
	
	for(var i=0; i<matchedData.length;i++){
		var item = matchedData[0];
		css = css.substring(0, item.start) + item.replaceStr + css.substring(item.end);
	}
	
    return css;
};

/*
 * Tests each selector in css file at specified resolution,
 * to see if any such elements appears above the fold on the page
 * modifies CSS - removes selectors that don't appear, and empty rules
 *
 * @param options.url the url as a string
 * @param options.css the css as a string
 * @param options.width the width of viewport
 * @param options.height the height of viewport
 * @param callback will be called with the result
 ---------------------------------------------------------*/
var getCriticalPathCss = function (options, callback) {

    page.viewportSize = {
        width: options.width,
        height: options.height
    };

    page.open(options.url, function (status) {
        var css;
        if (status !== 'success') {
            log('Unable to access network');
            phantom.exit();
        } else {
            page.evaluate(function (css) {
                var h = window.innerHeight,
                    split = css.split(/[{}]/g),
					renderWaitTime = 100, //ms
                    finished = false,
                    currIndex = 0,
                    forceRemoveNestedRule = false;

                var getNewValidCssSelector = function (i) {
                    var newSel = split[i];
					
                    if (newSel.indexOf("@font-face") > -1) {
                        //just leave @font-face rules in. TODO: rm unused @fontface rules.
                        currIndex = css.indexOf("}", currIndex) + 1;
                        return getNewValidCssSelector(i + 2);
                    }
                    else if (newSel.indexOf("@media") > -1) { //media queries..
                        //skip the media query line, which is not a css selector
                        return getNewValidCssSelector(i + 1);
                    }
                    else if (/@([a-z\-])*keyframe/g.test(newSel)) {
                        //remove @keyframe rules completely - don't belong in critical path css
                        //do it via forcing delete on child css rules (inside f.e. @keyframe declaration)
                        forceRemoveNestedRule = true;
                        return getNewValidCssSelector(i + 1);
                    }
                    else if (newSel.trim().length === 0) {
                        //end of nested rule (f.e. @media, @keyframe), or file..;

                        if (i + 1 >= split.length) {
                            //end of file
                            finished = true;
                            return false;
                        }
                        //end of nested selector, f.e. end of media query
                        forceRemoveNestedRule = false;
                        return getNewValidCssSelector(i + 1);
                    }
                    return i;
                };


	            var processCssRules = function(){
		            for (var i = 0; i < split.length; i = i + 2) {
			            //step over non DOM CSS selectors (@font-face, @media..)
			            i = getNewValidCssSelector(i);

			            //reach end of CSS
			            if (finished) {
				            //call final function to exit outside of phantom evaluate scope
				            window.callPhantom(css);
			            }

			            var fullSel = split[i];
			            //fullSel can contain combined selectors
			            //,f.e.  body, html {}
			            //split and check one such selector at the time.
			            var selSplit = fullSel.split(',');
			            //keep track - if we remove all selectors, we also want to remove the whole rule.
			            var selectorsKept = 0;

			            for (var j = 0; j < selSplit.length; j++) {
				            var sel = selSplit[j];

				            //some selectors can't be matched on page.
				            //In these cases we test a slightly modified selectors instead, temp.
				            var temp = sel;

				            if (sel.indexOf(":") > -1) {
					            //handle special case selectors, the ones that contain a semi colon (:)
					            //many of these selectors can't be matched to anything on page via JS,
					            //but that still might affect the above the fold styling

					            //these psuedo selectors depend on an element,
					            //so test element instead (would do the same for f.e. :focus, :active IF we wanted to keep them for critical path css, but we don't)
					            temp = temp.replace(/(:hover|:?:before|:?:after)*/g, '');

					            //if selector is purely psuedo (f.e. ::-moz-placeholder), just keep as is.
					            //we can't match it to anything on page, but it can impact above the fold styles
					            if (temp.replace(/:[:]?([a-zA-Z0-9\-\_])*/g, '').trim().length === 0) {
						            currIndex = css.indexOf(sel, currIndex) + sel.length;
						            continue;
					            }

					            //handle browser specific psuedo selectors bound to elements,
					            //Example, button::-moz-focus-inner, input[type=number]::-webkit-inner-spin-button
					            //remove browser specific pseudo and test for element
					            temp = temp.replace(/:?:-[a-z-]*/g, '');
				            }

				            if (!forceRemoveNestedRule) {
					            //now we have a selector to test, first grab any matching elements
					            try {
						            var el = document.querySelectorAll(temp);
					            } catch (e) {
						            continue;
					            }

					            //check if selector matched element(s) on page..
					            var aboveFold = false;

					            for (var k = 0; k < el.length; k++) {
						            var testEl = el[k];
						            //temporarily force clear none in order to catch elements that clear previous content themselves and who w/o their styles could show up unstyled in above the fold content (if they rely on f.e. "clear:both;" to clear some main content)
						            testEl.style.clear = "none";

						            //check to see if any matched element is above the fold on current page
						            //(in current viewport size)
						            if (testEl.getBoundingClientRect().top < h) {
							            //then we will save this selector
							            aboveFold = true;
							            selectorsKept++;

							            //update currIndex so we only search from this point from here on.
							            currIndex = css.indexOf(sel, currIndex);

							            //set clear style back to what it was
							            testEl.style.clear = "";
							            //break, because matching 1 element is enough
							            break;
						            }
						            //set clear style back to what it was
						            testEl.style.clear = "";
					            }
				            } else
					            aboveFold = false; //force removal of selector

				            //if selector didn't match any elements above fold - delete selector from CSS
				            if (aboveFold === false) {
					            var selPos = css.indexOf(sel, currIndex);
					            //update currIndex so we only search from this point from here on.
					            currIndex = css.indexOf(sel, currIndex);

					            //check what comes next: { or ,
					            var nextComma = css.indexOf(',', selPos);
					            var nextOpenBracket = css.indexOf('{', selPos);

					            if (selectorsKept > 0 || (nextComma > 0 && nextComma < nextOpenBracket)) {
						            //we already kept selectors from this rule, so rule will stay

						            //more selectors in selectorList, cut until (and including) next comma
						            if (nextComma > 0 && nextComma < nextOpenBracket) {
							            css = css.substring(0, selPos) + css.substring(nextComma + 1);
						            }
						            //final selector, cut until open bracket. Also remove previous comma, as the (new) last selector should not be followed by a comma.
						            else {
							            var prevComma = css.lastIndexOf(",", selPos);
							            css = css.substring(0, prevComma) + css.substring(nextOpenBracket);
						            }
					            }
					            else {
						            //no part of selector (list) matched elements above fold on page - remove whole rule CSS rule
						            var endRuleBracket = css.indexOf('}', nextOpenBracket);

						            css = css.substring(0, selPos) + css.substring(endRuleBracket + 1);
					            }
				            }
			            }
			            //if rule stayed, move our cursor forward for matching new selectors
			            if (selectorsKept > 0) {
				            currIndex = css.indexOf("}", currIndex) + 1;
			            }
		            }

		            //we're done - call final function to exit outside of phantom evaluate scope
		            window.callPhantom(css);


	            };

	            //give some time (renderWaitTime) for sites like facebook that build their page dynamically,
	            //otherwise we can miss some selectors (and therefor rules)
	            //--tradeoff here: if site is too slow with dynamic content,
	            //	it doesn't deserve to be in critical path.
	            setTimeout(processCssRules ,renderWaitTime);
               
            }, options.css);
        }
    });
};


var parser, parse, usage, options;

// test to see if we are running as a standalone script
// or as part of the node module
if( typeof embeddedParser !== 'undefined') { //standalone
	parse = parseOptions;
	usage = usageString;
} else {  // we are running in node
	parser = require('../options-parser');
	parse = parser.parse;
	usage = parser.usageString;
}

try {
	options = parse(system.args.slice(1));
} catch(ex) {
	errorlog('Caught error parsing arguments: ' + ex.message);
	errorlog('Usage: phantomjs penthouse.js ' + usage);
	phantom.exit(1);
}

// set defaults
if(!options.width) options.width = 1300;
if(!options.height) options.height = 900;

main(options);