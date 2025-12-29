import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );

function createPNG( size, r, g, b ) {

	const signature = Buffer.from( [ 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A ] );

	const ihdr = Buffer.alloc( 25 );
	ihdr.writeUInt32BE( 13, 0 );
	ihdr.write( 'IHDR', 4 );
	ihdr.writeUInt32BE( size, 8 );
	ihdr.writeUInt32BE( size, 12 );
	ihdr.writeUInt8( 8, 16 );
	ihdr.writeUInt8( 6, 17 ); // RGBA
	ihdr.writeUInt8( 0, 18 );
	ihdr.writeUInt8( 0, 19 );
	ihdr.writeUInt8( 0, 20 );
	ihdr.writeUInt32BE( crc32( ihdr.subarray( 4, 21 ) ), 21 );

	const rawData = [];
	for ( let y = 0; y < size; y ++ ) {

		rawData.push( 0 );
		for ( let x = 0; x < size; x ++ ) {

			const cx = x - size / 2, cy = y - size / 2;

			// VR headset body (rounded rectangle)
			const headsetBody = (
				Math.abs( cx ) < size * 0.45 &&
				Math.abs( cy ) < size * 0.28 &&
				! ( Math.abs( cx ) > size * 0.38 && Math.abs( cy ) > size * 0.2 )
			);

			// Left lens (circle)
			const leftLensDist = Math.sqrt( Math.pow( cx + size * 0.2, 2 ) + Math.pow( cy, 2 ) );
			const leftLens = leftLensDist < size * 0.18;
			const leftLensRing = leftLensDist < size * 0.18 && leftLensDist > size * 0.14;
			const leftLensInner = leftLensDist < size * 0.08;

			// Right lens (circle)
			const rightLensDist = Math.sqrt( Math.pow( cx - size * 0.2, 2 ) + Math.pow( cy, 2 ) );
			const rightLens = rightLensDist < size * 0.18;
			const rightLensRing = rightLensDist < size * 0.18 && rightLensDist > size * 0.14;
			const rightLensInner = rightLensDist < size * 0.08;

			// Nose bridge cutout
			const noseBridge = Math.abs( cx ) < size * 0.06 && cy > size * 0.05 && cy < size * 0.3;

			// Color selection (RGBA)
			if ( noseBridge ) {

				rawData.push( 0, 0, 0, 0 ); // Transparent

			} else if ( leftLensInner || rightLensInner ) {

				rawData.push( 100, 180, 255, 255 ); // Lens center highlight (light blue)

			} else if ( leftLensRing || rightLensRing ) {

				rawData.push( 60, 60, 80, 255 ); // Lens ring (dark)

			} else if ( leftLens || rightLens ) {

				rawData.push( 80, 140, 200, 255 ); // Lens glass (blue)

			} else if ( headsetBody ) {

				rawData.push( r, g, b, 255 ); // Headset body color

			} else {

				rawData.push( 0, 0, 0, 0 ); // Transparent

			}

		}

	}

	const compressed = zlib.deflateSync( Buffer.from( rawData ) );
	const idat = Buffer.alloc( 12 + compressed.length );
	idat.writeUInt32BE( compressed.length, 0 );
	idat.write( 'IDAT', 4 );
	compressed.copy( idat, 8 );
	idat.writeUInt32BE( crc32( Buffer.concat( [ Buffer.from( 'IDAT' ), compressed ] ) ), 8 + compressed.length );

	const iend = Buffer.from( [ 0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82 ] );

	return Buffer.concat( [ signature, ihdr, idat, iend ] );

}

function crc32( data ) {

	let crc = 0xFFFFFFFF;
	const table = [];
	for ( let i = 0; i < 256; i ++ ) {

		let c = i;
		for ( let j = 0; j < 8; j ++ ) c = ( c & 1 ) ? ( 0xEDB88320 ^ ( c >>> 1 ) ) : ( c >>> 1 );
		table[ i ] = c;

	}

	for ( let i = 0; i < data.length; i ++ ) crc = table[ ( crc ^ data[ i ] ) & 0xFF ] ^ ( crc >>> 8 );
	return ( crc ^ 0xFFFFFFFF ) >>> 0;

}

[ 16, 48, 128 ].forEach( size => {

	fs.writeFileSync( path.join( __dirname, `icon${size}.png` ), createPNG( size, 50, 50, 60 ) );
	console.log( `Created icon${size}.png` );

} );
