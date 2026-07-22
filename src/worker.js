
export default {
  async fetch(request, env, ctx) {
    console.info({ message: 'Hello World Worker received a request!' }); 
    return new Response('Hello World!');
  }
};