import {createChatServer} from '../server.mjs';
createChatServer({databasePath:':memory:'}).listen(4174,'127.0.0.1');
