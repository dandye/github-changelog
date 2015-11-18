#!/usr/bin/env node

require('./bootstrap');

var logger = require('winston');
var config = require('./config')(logger);
var fs = require('fs');
var cli = require('./cli');

var args = cli.parse(process.argv);
var template = fs.readFileSync(args.template, 'utf8');

var jira = require('./jira')(config.jira);

var github = require('./github')(
  {
    token: args.token
  },
  args.owner,
  args.repo
);

var changelog = require('./changelog')(github.api);

var range = github.helper.range(args.since, args.until);

var pullRequests = range
    .getPullRequests
    .flatMap(github.helper.jira(jira).fetch);

changelog.build(
  {
    json: args.json,
    gist: args.gist,
    release: args.release
  },
  template,
  range.sinceDateStream,
  range.untilDateStream,
  pullRequests,
  args.data
);
