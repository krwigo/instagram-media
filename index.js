const igUserId = process.env.IGUSERID;
const igAppId = process.env.IGAPPID;
const igAppSec = process.env.IGAPPSEC;
const cbUrl = process.env.CBURL;

const mongodb = require("mongodb");
const cors = require("cors");
const express = require("express");
const server = express();

server.use(express.json({}));
server.use(express.urlencoded({ extended: true }));
server.use(express.raw({}));
server.use(cors());
server.disable("x-powered-by");

global.fetch = require("isomorphic-fetch");

async function refreshToken(host, access_token) {
	let d = await (
		await fetch(
			`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${access_token}`
		)
	).json();

	console.log(
		"refreshToken:",
		JSON.stringify(
			await db.collection("instagram_users").updateOne(
				{
					host: host,
					"token.access_token": access_token,
				},
				{
					$set: {
						token: d,
					},
				}
			)
		)
	);
}

async function refreshTokenAll() {
	console.log("refreshTokenAll()");

	let cur = await db.collection("instagram_users").find();
	let doc;

	while ((doc = await cur.next())) {
		console.log(
			"refreshTokenAll():",
			String(doc._id),
			doc.host,
			doc.token.access_token
		);
		await refreshToken(doc.host, doc.token.access_token);
	}
}

async function refreshMedia(host, access_token) {
	const fields = [
		"id",
		"media_type",
		"caption",
		"permalink",
		"media_url",
		"thumbnail_url",
		"timestamp",
	];

	let results = [];
	let url = `https://graph.instagram.com/me/media?fields=${fields}&access_token=${access_token}`;
	let d;

	while (url) {
		d = await (await fetch(url)).json();

		url = d?.paging?.next || false;

		if (!Array.isArray(d?.data)) {
			break;
		}

		results = results.concat(results, d.data);
		console.log("paging;", d.data.length, results.length);

		// if (results.length >= 25) {
		// break;
		// }
	}

	console.log(
		"refreshMedia()",
		JSON.stringify(
			await db.collection("instagram_users").updateOne(
				{
					host: host,
					"token.access_token": access_token,
				},
				{
					$set: {
						media: results,
						media25: results.slice(0, 25),
					},
				}
			)
		)
	);
}

async function refreshMediaAll() {
	console.log("refreshMediaAll()");

	let cur = await db.collection("instagram_users").find();
	let doc;

	while ((doc = await cur.next())) {
		console.log(
			"refreshMediaAll():",
			String(doc._id),
			doc.host,
			doc.token.access_token
		);
		await refreshMedia(doc.host, doc.token.access_token);
	}
}

async function apiMedia(req, res) {
	const user_id = /\/(\d+)/.exec(req.path)?.[1] || igUserId || null;

	const doc = await db.collection("instagram_users").findOne({
		user_id: +user_id,
	});

	res
		.set("Cache-Control", `public, max-age=${3600 * 6}`)
		.setHeader("Content-Type", "application/json")
		.status(200)
		.json(Array.isArray(doc?.media25) ? doc.media25 : []);
}

server.all("/media", apiMedia);

server.all("/media/:user_id", apiMedia);

async function apiAuth(req, res) {
	if (!req.query?.code) {
		console.log(req.path, "redirect()");
		let reUrl = `https://api.instagram.com/oauth/authorize?client_id=${igAppId}&redirect_uri=${cbUrl}&scope=user_profile,user_media&response_type=code`;
		res.redirect(reUrl);
		return;
	}

	// task: exchange short lived token
	let ds = await (
		await fetch(`https://api.instagram.com/oauth/access_token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: igAppId,
				client_secret: igAppSec,
				redirect_uri: cbUrl,
				code: req.query.code,
			}),
		})
	).json();

	// task: exchange long lived token
	let dl = await (
		await fetch(
			`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${igAppSec}&access_token=${ds.access_token}`
		)
	).json();

	console.log(
		req.path,
		"updateOne()",
		await db.collection("instagram_users").updateOne(
			{
				host: req.headers.host,
				user_id: ds.user_id,
			},
			{
				$set: {
					host: req.headers.host,
					user_id: ds.user_id,
					//
					auth: ds,
					token: dl,
				},
			},
			{ upsert: true }
		)
	);

	res.status(200).json({ status: "OK" });

	await refreshMedia(req.headers.host, dl.access_token);
}

server.all("/auth", apiAuth);

mongodb.MongoClient.connect(
	process.env.DBHOST,
	{
		useNewUrlParser: true,
		useUnifiedTopology: true,
	},
	(err, client) => {
		if (err) {
			console.error("MongoClient", { err });
			return process.exit();
		}

		global.db = client.db(process.env.DBNAME);

		if (process.env.REFRESHMEDIAALL) {
			refreshMediaAll().then(process.exit);
			return;
		}

		if (process.env.REFRESHTOKENALL) {
			refreshTokenAll().then(process.exit);
			return;
		}

		setInterval(refreshMediaAll, 1000 * 3600 * 24);

		setInterval(refreshTokenAll, 1000 * 3600 * 24);

		server.listen(5240, function () {
			console.log("listen:", this.address());
			console.log(cbUrl);
		});
	}
);
