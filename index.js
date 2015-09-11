#!/usr/bin/env node

// core modules
var fs = require('fs');
var path = require('path');

// 3rd party modules
var Client = require('github');
var ejs = require('ejs');
var program = require('commander');
var Bacon = require('baconjs');

program
    .option('-o, --owner <name>', 'Repository owner name.  If not provided, ' +
        'the "username" option will be used.')
    .option('-r, --repo <repo>', 'Repository name (required).')
    .option('-u, --username <name>', 'Your GitHub username (only required ' +
        'for private repos).')
    .option('-p, --password <pass>', 'Your GitHub password (only required ' +
        'for private repos).')
    .option('-t, --token <token>', 'Your GitHub token (only required ' +
          'for private repos or if you want to bypass the Github API limit rate).')
    .option('-s, --since <iso-date>', 'Initial date or commit sha.')
    .option('--until <iso-date>', 'Limit date or commit sha.')
    .option('-m, --merged', 'List merged pull requests only.')
    .option('-e, --header <header>', 'Header text.  Default is "Changes ' +
        'between <since> and <until>".')
    .option('-t, --template <path>', 'EJS template to format data.' +
        'The default bundled template generates a list of issues in Markdown')
    .option('-g, --gist', 'Publish output to a Github gist.')
    .parse(process.argv);

if (!program.repo) {
  program.help();
  process.exit(1);
}

if (!program.username && !program.owner && !program.token) {
  console.error('\nOne of "username" or "owner" or "token" options must be provided');
  program.help();
  process.exit(1);
}

if (!program.since) {
  console.error('\n"Since" option must be provided');
  program.help();
  process.exit(1);
}

var templatePath = program.template || path.join(__dirname, 'changelog.ejs');
var template = fs.readFileSync(templatePath, 'utf8');
var changelog = ejs.compile(template);

var github = new Client({version: '3.0.0'});

if (program.token) {
  github.authenticate({
    type: 'oauth',
    token: program.token
  });
}
else if (program.username && program.password) {
  github.authenticate({
    type: 'basic',
    username: program.username,
    password: program.password
  });
}

var header = program.header || 'Changes since ' + program.since;
var owner = program.owner || program.username;

function isDate(value) {
  const date = new Date(value);
  return !isNaN(date.valueOf());
}

function transformCommitIdToDate(commitId) {
  var params = {
    user: owner,
    repo: program.repo,
    sha: commitId
  };

  return Bacon
    .fromNodeCallback(github.gitdata.getCommit, params)
    .flatMap('.author.date');
}

function streamPagePullRequests(page) {
  var params = {
    user: owner,
    repo: program.repo,
    base: 'master',
    state: 'closed',
    sort: 'updated',
    direction: 'desc',
    per_page: 50,
    page: page
  };

  return Bacon
    .fromNodeCallback(github.pullRequests.getAll, params)
    .flatMap(Bacon.fromArray);
}

function getPullRequestClosedSinceFilter(dateString) {
  return function(pullRequest) {
    return new Date(pullRequest.closed_at) > new Date(dateString);
  }
}

function getPullRequestClosedUntilFilter(dateString) {
  return function(pullRequest) {
    return new Date(pullRequest.closed_at) <= new Date(dateString);
  }
}

/**
 * @param {Object} params of type:
 * {
 *   since: '2015-09-07T10:16:41Z',
 *   until: '2015-09-10T12:50:09Z'
 * }
 */
function streamAllPullRequestsBetween(params) {
  var paginationNeeded = true;

  console.log('since: ', params.since)
  console.log('until: ', params.until)

  return Bacon.repeat(function(index) {

    if (!paginationNeeded) {
      return false;
    }

    var stream = streamPagePullRequests(index + 1)
      .doAction(function(pullRequest) {
        if (new Date(pullRequest.updated_at) < new Date(params.since)) {
          paginationNeeded = false;
        }
      })
      .filter(getPullRequestClosedSinceFilter(params.since));

    if (params.until) {
      stream = stream.filter(getPullRequestClosedUntilFilter(params.until));
    }

    return stream;
  });
}

function createGist(text) {
  var params = {
    description: 'Release note',
    public: false,
    files: {
      'release note.md': {
        content: text
      }
    }
  };

  return Bacon
    .fromNodeCallback(github.gists.create, params)
    .map('.html_url');
}

/**
 * Get a stream providing a single string date,
 * the incoming parameter being either a date string or a commit sha.
 */
function streamDateFromDateStringOrCommitId(dateStringOrCommitId) {
  return Bacon
    .once(dateStringOrCommitId)
    .flatMap(function(value) {
      if (isDate(value)) {
        return value;
      }
      if (value) {
        return transformCommitIdToDate(value);
      }
      return undefined;
    });
}


var sinceDateStream  = streamDateFromDateStringOrCommitId(program.since);
var untilDateStream = streamDateFromDateStringOrCommitId(program.until);

// Get a stream providing the pull requests.
var pullRequests = Bacon
  .combineTemplate({ since: sinceDateStream, until: untilDateStream })
  .flatMap(streamAllPullRequestsBetween);

// Keep only merged pull requests if specified.
if (program.merged) {
  pullRequests = pullRequests.filter(function(pullRequest) {
    return pullRequest.merged_at !== null;
  });
}

// Generate changelog text.
var changelogText = pullRequests
  .reduce([], '.concat')
  .map(function(allPullRequests) {
    return changelog({header: header, issues: allPullRequests});
  });

// Generate a gist if specified.
if (program.gist) {
  changelogText = changelogText.flatMap(createGist);
}

// Generate a release if specified
if (program.release) {
  // @todo
}

changelogText.log();
