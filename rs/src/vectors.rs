//! What bun says, recorded by rs/vectors.gen.mjs into testdata/vectors.json,
//! against what the port says: `new URL`, `redactUrl` and `knownSecrets`
//! for thousands of inputs. A text the URL reader is not sure of proves
//! nothing (it hands back); every other answer has to be bun's.

use crate::json::{parse_js, Json};
use crate::machine::Env;
use crate::{redact, url};

const VECTORS: &str = include_str!("testdata/vectors.json");

fn rows(key: &str) -> Vec<Vec<Json>> {
    let all = parse_js(VECTORS).expect("testdata/vectors.json is JSON");
    match all.get(key) {
        Some(Json::Arr(rows)) => rows.iter().map(|row| if let Json::Arr(items) = row { items.clone() } else { panic!("{key}: a row that is not a list") }).collect(),
        _ => panic!("testdata/vectors.json has no {key}"),
    }
}

fn text(value: &Json) -> &str {
    match value {
        Json::Str(text) => text,
        other => panic!("not a string: {other:?}"),
    }
}

#[test]
fn urls_as_bun_reads_them() {
    let (mut taken, mut invalid, mut unsure) = (0, 0, 0);
    for row in rows("urls") {
        let input = text(&row[0]);
        match url::parse(input) {
            Ok(parsed) => {
                let Json::Str(href) = &row[1] else { panic!("{input:?}: read as {parsed:?}, but bun's URL throws") };
                assert_eq!(&parsed.without_credentials(), href, "{input:?}");
                assert_eq!(parsed.username, text(&row[2]), "{input:?}: username");
                assert_eq!(parsed.password, text(&row[3]), "{input:?}: password");
                taken += 1;
            }
            Err(url::Parsed::Invalid) => {
                assert_eq!(row[1], Json::Null, "{input:?}: taken as invalid, but bun's URL reads it");
                invalid += 1;
            }
            Err(url::Parsed::Unsure) => unsure += 1,
        }
    }
    // The comparison has to have something to compare.
    assert!(taken > 500 && invalid > 300, "{taken} read, {invalid} invalid, {unsure} not sure");
}

#[test]
fn redact_url_as_redact_ts() {
    for row in rows("redact") {
        let input = text(&row[0]);
        let expected = row.get(1).map(text).unwrap_or(input);
        assert_eq!(redact::redact_url(input), expected, "{input:?}");
    }
}

#[test]
fn known_secrets_as_redact_ts() {
    let mut compared = 0;
    for row in rows("secrets") {
        let mut vars = Vec::new();
        if let Json::Str(token) = &row[0] {
            vars.push(("WINRPC_TOKEN", token.as_str()));
        }
        if let Json::Str(url) = &row[1] {
            vars.push(("WINRPC_URL", url.as_str()));
        }
        let Json::Arr(expected) = &row[2] else { panic!("secrets: not a list") };
        let expected: Vec<String> = expected.iter().map(|secret| text(secret).to_string()).collect();
        if let Ok(known) = redact::known(&Env::with(&vars)) {
            assert_eq!(known, expected, "{vars:?}");
            compared += 1;
        }
    }
    assert!(compared > 50, "{compared}");
}
