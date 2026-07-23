
export default {
	async fetch(request, env, ctx) {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		const origin = request.headers.get("Origin");
		if (origin !== "https://www.hrtalentalliance.com") {
			return new Response("Forbidden", { status : 403 });
		}

		const formData = await request.json();

		console.log(formData);

		return new Response("Ok", { status: 200 });
	}
};